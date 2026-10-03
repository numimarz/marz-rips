-- Marketplace is opt-in, one-for-one, same pack tier. No cash value or store credit.
create table public.mr_trade_listings (
 id uuid primary key default gen_random_uuid(),
 owner_id uuid not null references auth.users(id),
 pull_id uuid not null references public.mr_pulls(id),
 tier_cents int not null check(tier_cents in (100,300,500,900,1300)),
 status text not null default 'listed' check(status in ('listed','swapped','cancelled')),
 created_at timestamptz not null default now(), completed_at timestamptz
);
create unique index mr_one_active_listing on public.mr_trade_listings(pull_id) where status='listed';
create index mr_trade_pool_index on public.mr_trade_listings(status,tier_cents,created_at desc);
create index mr_trade_owner_index on public.mr_trade_listings(owner_id,status);
create table public.mr_trades (
 id uuid primary key default gen_random_uuid(), listing_id uuid not null unique references public.mr_trade_listings(id),
 maker_id uuid not null references auth.users(id), taker_id uuid not null references auth.users(id),
 requested_pull uuid not null references public.mr_pulls(id), offered_pull uuid not null references public.mr_pulls(id),
 requested_title text not null, offered_title text not null, tier_cents int not null,
 request_id uuid not null, created_at timestamptz not null default now(), unique(taker_id,request_id), check(maker_id<>taker_id),check(requested_pull<>offered_pull)
);
create index mr_trades_maker_index on public.mr_trades(maker_id,created_at desc);
create index mr_trades_taker_index on public.mr_trades(taker_id,created_at desc);
alter table public.mr_trade_listings enable row level security;
alter table public.mr_trades enable row level security;
revoke all on public.mr_trade_listings,public.mr_trades from anon,authenticated;
grant all on public.mr_trade_listings,public.mr_trades to service_role;
grant select on public.mr_trades to authenticated;
create policy own_trade_history on public.mr_trades for select to authenticated using((select auth.uid())=maker_id or (select auth.uid())=taker_id);

create function public.mr_list_trade(p_user uuid,p_pull uuid) returns uuid language plpgsql security invoker set search_path='' as $$
declare p public.mr_pulls; v_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 if not exists(select 1 from public.mr_memberships where user_id=p_user and status='active' and paid_until>now()) then raise exception 'An active subscription is required to list cards'; end if;
 select * into p from public.mr_pulls where id=p_pull and user_id=p_user for update;
 if p.id is null then raise exception 'This card is not in your account'; end if;
 if p.shipping_status<>'held' then raise exception 'Cards requested for shipping cannot be traded'; end if;
 select id into v_id from public.mr_trade_listings where pull_id=p.id and status='listed';
 if v_id is not null then return v_id; end if;
 insert into public.mr_trade_listings(owner_id,pull_id,tier_cents) values(p_user,p.id,p.tier_cents) returning id into v_id;
 insert into public.mr_audit(actor,action,record_id,details) values(p_user,'trade_listed',v_id,jsonb_build_object('pull_id',p.id,'consent','any one held card from same pack tier'));
 return v_id;
end $$;
create function public.mr_cancel_trade(p_user uuid,p_listing uuid) returns void language plpgsql security invoker set search_path='' as $$
declare l public.mr_trade_listings;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 select * into l from public.mr_trade_listings where id=p_listing and owner_id=p_user for update;
 if l.id is null then raise exception 'Listing not found in your account'; end if;
 if l.status='swapped' then raise exception 'This trade already completed'; end if;
 update public.mr_trade_listings set status='cancelled',completed_at=now() where id=l.id;
 insert into public.mr_audit(actor,action,record_id) values(p_user,'trade_cancelled',l.id);
end $$;
create function public.mr_swap_trade(p_user uuid,p_listing uuid,p_offer uuid,p_request uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare l public.mr_trade_listings; want public.mr_pulls; offer public.mr_pulls; existing public.mr_trades; v_trade public.mr_trades;
begin
 select * into l from public.mr_trade_listings where id=p_listing;
 if l.id is null then raise exception 'This listing is no longer available'; end if;
 if l.owner_id=p_user then raise exception 'You cannot trade with yourself'; end if;
 -- All customer operations use the same locks. Sort participants to prevent cross-trade deadlocks.
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(least(l.owner_id::text,p_user::text),0));
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(greatest(l.owner_id::text,p_user::text),0));
 select * into existing from public.mr_trades where taker_id=p_user and request_id=p_request;
 if existing.id is not null then
  if existing.listing_id<>p_listing or existing.offered_pull<>p_offer then raise exception 'Trade request mismatch'; end if;
  return to_jsonb(existing);
 end if;
 if not exists(select 1 from public.mr_memberships where user_id=p_user and status='active' and paid_until>now()) or not exists(select 1 from public.mr_memberships where user_id=l.owner_id and status='active' and paid_until>now()) then raise exception 'Both collectors need an active subscription'; end if;
 select * into l from public.mr_trade_listings where id=p_listing for update;
 if l.status<>'listed' then raise exception 'Someone already traded for this card, or the listing was withdrawn'; end if;
 perform 1 from public.mr_pulls where id in(l.pull_id,p_offer) order by id for update;
 select * into want from public.mr_pulls where id=l.pull_id;
 select * into offer from public.mr_pulls where id=p_offer and user_id=p_user;
 if want.user_id<>l.owner_id or offer.id is null then raise exception 'Card ownership changed; refresh the trade pool'; end if;
 if want.shipping_status<>'held' or offer.shipping_status<>'held' then raise exception 'Only held cards can be traded; shipping has already been requested'; end if;
 if want.tier_cents<>offer.tier_cents or want.tier_cents<>l.tier_cents then raise exception 'Offer one card from the same pack tier'; end if;
 insert into public.mr_trades(listing_id,maker_id,taker_id,requested_pull,offered_pull,requested_title,offered_title,tier_cents,request_id)
 values(l.id,l.owner_id,p_user,want.id,offer.id,want.title,offer.title,l.tier_cents,p_request) returning * into v_trade;
 update public.mr_trade_listings set status='swapped',completed_at=now() where id=l.id;
 -- Withdraw the offered card from any other active listing as part of this same transaction.
 update public.mr_trade_listings set status='cancelled',completed_at=now() where pull_id=offer.id and status='listed';
 update public.mr_pulls set user_id=p_user where id=want.id;
 update public.mr_pulls set user_id=l.owner_id where id=offer.id;
 insert into public.mr_audit(actor,action,record_id,details) values(p_user,'trade_completed',v_trade.id,jsonb_build_object('listing',l.id,'requested_pull',want.id,'offered_pull',offer.id));
 return to_jsonb(v_trade);
end $$;
revoke all on function public.mr_list_trade(uuid,uuid),public.mr_cancel_trade(uuid,uuid),public.mr_swap_trade(uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.mr_list_trade(uuid,uuid),public.mr_cancel_trade(uuid,uuid),public.mr_swap_trade(uuid,uuid,uuid,uuid) to service_role;


create or replace function public.mr_open_pack(p_user uuid,p_pack uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.mr_packs; c public.mr_inventory; v_count int; v_bonus uuid; v_pull public.mr_pulls;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 select * into p from public.mr_packs where id=p_pack and user_id=p_user for update;
 if p.id is null then raise exception 'Pack not found'; end if;
 if p.status='opened' then select * into v_pull from public.mr_pulls where pack_id=p.id; if v_pull.user_id<>p_user then raise exception 'This card was traded to another collector'; end if; return to_jsonb(v_pull); end if;
 if p.status<>'ready' then raise exception 'Payment has not been confirmed'; end if;
 select * into c from public.mr_inventory where id=p.inventory_id for update;
 if c.status<>'reserved' then raise exception 'Inventory mismatch; contact support'; end if;
 insert into public.mr_pulls(user_id,pack_id,inventory_id,title,rarity,image_url,tier_cents,kind) values(p_user,p.id,c.id,c.title,c.rarity,c.image_url,p.tier_cents,p.kind) returning * into v_pull;
 update public.mr_packs set status='opened' where id=p.id;
 if p.kind='paid' then
  select count(*) into v_count from public.mr_packs where user_id=p_user and kind='paid' and status='opened';
  if v_count%10=0 then
   select id into v_bonus from public.mr_inventory where pool='bonus' and tier_cents=100 and status='available' order by random() limit 1 for update skip locked;
   if v_bonus is null then raise exception 'Bonus inventory needs replenishment; your paid pack is still ready'; end if;
   update public.mr_inventory set status='reserved' where id=v_bonus;
   insert into public.mr_packs(user_id,inventory_id,tier_cents,kind,milestone,status) values(p_user,v_bonus,100,'bonus',v_count,'ready');
  end if;
 end if;
 insert into public.mr_audit(actor,action,record_id) values(p_user,'pack_opened',p.id);
 return to_jsonb(v_pull);
end $$;
create or replace function public.mr_request_shipping(p_user uuid,p_address jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_ids uuid[]; v_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 if not exists(select 1 from public.mr_settings where shipping_enabled) then raise exception 'Physical shipping is not open yet'; end if;
 if not exists(select 1 from public.mr_memberships where user_id=p_user and status='active' and paid_until>now()) then raise exception 'Physical shipping requires an active $1/month subscription'; end if;
 select array_agg(id) into v_ids from public.mr_pulls where user_id=p_user and shipping_status='held';
 if v_ids is null then raise exception 'No eligible physical cards are held'; end if;
 insert into public.mr_shipping(user_id,address,pull_ids) values(p_user,p_address,v_ids) returning id into v_id;
 update public.mr_trade_listings set status='cancelled',completed_at=now() where owner_id=p_user and pull_id=any(v_ids) and status='listed';
 update public.mr_pulls set shipping_status='requested' where id=any(v_ids);
 insert into public.mr_audit(actor,action,record_id) values(p_user,'shipping_requested',v_id);
 return v_id;
end $$;