-- Marz Rips records are isolated from Buddy's tables in this shared project.
create table public.mr_admins (user_id uuid primary key references auth.users(id), created_at timestamptz not null default now());
create table public.mr_profiles (user_id uuid primary key references auth.users(id), display_name text not null default 'Collector' check(length(display_name)<=80), demo_data jsonb not null default '{}' check(octet_length(demo_data::text)<1000000), folders jsonb not null default '[]' check(octet_length(folders::text)<100000), updated_at timestamptz not null default now());
create table public.mr_memberships (user_id uuid primary key references auth.users(id), stripe_subscription text unique, stripe_customer text, status text not null default 'inactive', paid_until timestamptz, updated_at timestamptz not null default now());
create table public.mr_settings (id boolean primary key default true check(id), sales_enabled boolean not null default false, shipping_enabled boolean not null default false);
insert into public.mr_settings(id) values(true);
create table public.mr_inventory (id uuid primary key default gen_random_uuid(), sku text not null unique check(length(sku)<=80), title text not null check(length(title)<=160), rarity text not null default 'COMMON', image_url text check(image_url is null or image_url ~ '^https://'), tier_cents int not null check(tier_cents in (100,300,500,900,1300)), pool text not null default 'sale' check(pool in ('sale','bonus')), status text not null default 'available' check(status in ('available','reserved','shipped')), created_at timestamptz not null default now());
create table public.mr_packs (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), inventory_id uuid not null references public.mr_inventory(id), tier_cents int not null, kind text not null check(kind in ('paid','bonus')), milestone int, status text not null default 'awaiting_payment' check(status in ('awaiting_payment','ready','opened','expired','refunded')), stripe_session text unique, stripe_payment text unique, expires_at timestamptz, created_at timestamptz not null default now(), unique(user_id,milestone));
create table public.mr_pulls (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), pack_id uuid not null unique references public.mr_packs(id), inventory_id uuid not null unique references public.mr_inventory(id), title text not null, rarity text not null, image_url text, tier_cents int not null, kind text not null, shipping_status text not null default 'held' check(shipping_status in ('held','requested','packing','shipped')), opened_at timestamptz not null default now());
create table public.mr_shipping (id uuid primary key default gen_random_uuid(), user_id uuid not null references auth.users(id), address jsonb not null, pull_ids uuid[] not null check(cardinality(pull_ids)>0), status text not null default 'requested' check(status in ('requested','packing','shipped')), carrier text, tracking text, fee_status text not null default 'quote_needed' check(fee_status in ('quote_needed','paid','waived')), notes text, created_at timestamptz not null default now(), shipped_at timestamptz);
create table public.mr_events (stripe_id text primary key, event_type text not null, created_at timestamptz not null default now());
create table public.mr_audit (id bigint generated always as identity primary key, actor uuid, action text not null, record_id uuid, details jsonb not null default '{}', created_at timestamptz not null default now());
create index on public.mr_packs(user_id,status); create index on public.mr_pulls(user_id,opened_at desc); create index on public.mr_shipping(status,created_at); create index on public.mr_inventory(status,pool,tier_cents);
alter table public.mr_admins enable row level security; alter table public.mr_profiles enable row level security; alter table public.mr_memberships enable row level security; alter table public.mr_settings enable row level security; alter table public.mr_inventory enable row level security; alter table public.mr_packs enable row level security; alter table public.mr_pulls enable row level security; alter table public.mr_shipping enable row level security; alter table public.mr_events enable row level security; alter table public.mr_audit enable row level security;
-- Customer reads only their own records. All commerce writes go through verified server operations.
revoke all on public.mr_admins,public.mr_profiles,public.mr_memberships,public.mr_settings,public.mr_inventory,public.mr_packs,public.mr_pulls,public.mr_shipping,public.mr_events,public.mr_audit from anon,authenticated;
grant all on public.mr_admins,public.mr_profiles,public.mr_memberships,public.mr_settings,public.mr_inventory,public.mr_packs,public.mr_pulls,public.mr_shipping,public.mr_events,public.mr_audit to service_role;
grant usage,select on sequence public.mr_audit_id_seq to service_role;
grant select on public.mr_profiles,public.mr_memberships,public.mr_packs,public.mr_pulls,public.mr_shipping to authenticated;
grant insert(user_id,display_name,demo_data,folders),update(display_name,demo_data,folders,updated_at) on public.mr_profiles to authenticated;
create policy own_profile_read on public.mr_profiles for select to authenticated using((select auth.uid())=user_id);
create policy own_profile_insert on public.mr_profiles for insert to authenticated with check((select auth.uid())=user_id);
create policy own_profile_update on public.mr_profiles for update to authenticated using((select auth.uid())=user_id) with check((select auth.uid())=user_id);
create policy own_membership on public.mr_memberships for select to authenticated using((select auth.uid())=user_id);
create policy own_packs on public.mr_packs for select to authenticated using((select auth.uid())=user_id);
create policy own_pulls on public.mr_pulls for select to authenticated using((select auth.uid())=user_id);
create policy own_shipping on public.mr_shipping for select to authenticated using((select auth.uid())=user_id);
-- Assign the verified owner separately after installing the schema.

-- SECURITY INVOKER, executable ONLY by the server role. Locks serialize payment/open/ship races.
create function public.mr_reserve_pack(p_user uuid,p_tier int) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_card uuid; v_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 if not exists(select 1 from public.mr_settings where sales_enabled) then raise exception 'Paid pack sales are not open yet'; end if;
 if p_tier not in (100,300,500,900,1300) then raise exception 'Unknown tier'; end if;
 if p_tier=100 and not exists(select 1 from public.mr_memberships where user_id=p_user and status='active' and paid_until>now()) then raise exception 'An active subscription is required for $1 packs'; end if;
 if (select count(*) from public.mr_packs where user_id=p_user and status='awaiting_payment')>=3 then raise exception 'Finish or wait for existing checkout reservations'; end if;
 if not exists(select 1 from public.mr_inventory where pool='bonus' and status='available') then raise exception 'Bonus stock must be replenished before sales'; end if;
 select id into v_card from public.mr_inventory where tier_cents=p_tier and pool='sale' and status='available' order by random() limit 1 for update skip locked;
 if v_card is null then raise exception 'This tier is sold out'; end if;
 update public.mr_inventory set status='reserved' where id=v_card;
 insert into public.mr_packs(user_id,inventory_id,tier_cents,kind,expires_at) values(p_user,v_card,p_tier,'paid',now()+interval '31 minutes') returning id into v_id;
 return v_id;
end $$;
create function public.mr_expire_pack(p_pack uuid) returns void language plpgsql security invoker set search_path='' as $$
declare p public.mr_packs;
begin select * into p from public.mr_packs where id=p_pack for update;
 if p.status='awaiting_payment' then update public.mr_packs set status='expired' where id=p.id; update public.mr_inventory set status='available' where id=p.inventory_id; end if;
end $$;
create function public.mr_confirm_pack(p_pack uuid,p_session text,p_payment text) returns void language plpgsql security invoker set search_path='' as $$
declare p public.mr_packs;
begin select * into p from public.mr_packs where id=p_pack for update;
 if p.stripe_session is distinct from p_session then raise exception 'Checkout mismatch'; end if;
 if p.status='awaiting_payment' then update public.mr_packs set status='ready',stripe_payment=p_payment where id=p.id;
 elsif p.status not in ('ready','opened') then raise exception 'Reservation unavailable; payment needs review'; end if;
end $$;
create function public.mr_open_pack(p_user uuid,p_pack uuid) returns jsonb language plpgsql security invoker set search_path='' as $$
declare p public.mr_packs; c public.mr_inventory; v_count int; v_bonus uuid; v_pull public.mr_pulls;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 select * into p from public.mr_packs where id=p_pack and user_id=p_user for update;
 if p.id is null then raise exception 'Pack not found'; end if;
 if p.status='opened' then select * into v_pull from public.mr_pulls where pack_id=p.id; return to_jsonb(v_pull); end if;
 if p.status<>'ready' then raise exception 'Payment has not been confirmed'; end if;
 select * into c from public.mr_inventory where id=p.inventory_id for update;
 if c.status<>'reserved' then raise exception 'Inventory mismatch; contact support'; end if;
 insert into public.mr_pulls(user_id,pack_id,inventory_id,title,rarity,image_url,tier_cents,kind) values(p_user,p.id,c.id,c.title,c.rarity,c.image_url,p.tier_cents,p.kind) returning * into v_pull;
 update public.mr_packs set status='opened' where id=p.id;
 if p.kind='paid' then
  select count(*) into v_count from public.mr_pulls where user_id=p_user and kind='paid';
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
create function public.mr_request_shipping(p_user uuid,p_address jsonb) returns uuid language plpgsql security invoker set search_path='' as $$
declare v_ids uuid[]; v_id uuid;
begin
 perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_user::text,0));
 if not exists(select 1 from public.mr_settings where shipping_enabled) then raise exception 'Physical shipping is not open yet'; end if;
 if not exists(select 1 from public.mr_memberships where user_id=p_user and status='active' and paid_until>now()) then raise exception 'Physical shipping requires an active $1/month subscription'; end if;
 select array_agg(id) into v_ids from public.mr_pulls where user_id=p_user and shipping_status='held';
 if v_ids is null then raise exception 'No eligible physical cards are held'; end if;
 insert into public.mr_shipping(user_id,address,pull_ids) values(p_user,p_address,v_ids) returning id into v_id;
 update public.mr_pulls set shipping_status='requested' where id=any(v_ids);
 insert into public.mr_audit(actor,action,record_id) values(p_user,'shipping_requested',v_id);
 return v_id;
end $$;
create function public.mr_fulfill_shipping(p_admin uuid,p_order uuid,p_status text,p_carrier text,p_tracking text,p_fee text,p_notes text) returns void language plpgsql security invoker set search_path='' as $$
declare s public.mr_shipping;
begin
 if not exists(select 1 from public.mr_admins where user_id=p_admin) then raise exception 'Admin access required'; end if;
 select * into s from public.mr_shipping where id=p_order for update;
 if s.id is null then raise exception 'Shipping request not found'; end if;
 if s.status='shipped' then raise exception 'Shipment already fulfilled'; end if;
 if p_status not in ('packing','shipped') or p_fee not in ('quote_needed','paid','waived') then raise exception 'Invalid fulfillment state'; end if;
 if p_status='shipped' and (length(trim(coalesce(p_tracking,'')))=0 or length(trim(coalesce(p_carrier,'')))=0 or p_fee='quote_needed') then raise exception 'Record carrier, tracking, and paid or waived shipping first'; end if;
 update public.mr_shipping set status=p_status,carrier=p_carrier,tracking=p_tracking,fee_status=p_fee,notes=p_notes,shipped_at=case when p_status='shipped' then now() else null end where id=s.id;
 update public.mr_pulls set shipping_status=p_status where id=any(s.pull_ids);
 if p_status='shipped' then update public.mr_inventory set status='shipped' where id in(select inventory_id from public.mr_pulls where id=any(s.pull_ids)); end if;
 insert into public.mr_audit(actor,action,record_id,details) values(p_admin,'fulfillment_'||p_status,s.id,jsonb_build_object('carrier',p_carrier,'tracking',p_tracking,'fee_status',p_fee));
end $$;
revoke all on function public.mr_reserve_pack(uuid,int),public.mr_expire_pack(uuid),public.mr_confirm_pack(uuid,text,text),public.mr_open_pack(uuid,uuid),public.mr_request_shipping(uuid,jsonb),public.mr_fulfill_shipping(uuid,uuid,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.mr_reserve_pack(uuid,int),public.mr_expire_pack(uuid),public.mr_confirm_pack(uuid,text,text),public.mr_open_pack(uuid,uuid),public.mr_request_shipping(uuid,jsonb),public.mr_fulfill_shipping(uuid,uuid,text,text,text,text,text) to service_role;
