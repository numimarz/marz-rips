-- Run as postgres. All fixtures and state changes are rolled back; no customer or billing data persists.
begin;
do $$
declare u uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); c uuid; p uuid; p2 uuid; result jsonb; n int; denied boolean; k int;
begin
 insert into auth.users(id,email) values(u,'marz-transaction-test@example.invalid'),(v,'marz-other-test@example.invalid');
 update public.mr_settings set sales_enabled=true,shipping_enabled=true;
 insert into public.mr_inventory(sku,title,tier_cents,pool) values('TEST-BONUS-ROLLBACK','Bonus test card',100,'bonus');
 insert into public.mr_inventory(sku,title,tier_cents) values('TEST-ONE-ROLLBACK','Member card',100) returning id into c;
 denied:=false;begin perform public.mr_reserve_pack(u,100);exception when others then denied:=sqlerrm like '%active subscription%';end;if not denied then raise exception 'FAILED: nonmember accessed $1 tier';end if;
 insert into public.mr_memberships(user_id,status,paid_until) values(u,'active',now()+interval '1 day');
 p:=public.mr_reserve_pack(u,100);
 denied:=false;begin perform public.mr_open_pack(u,p);exception when others then denied:=sqlerrm like '%not been confirmed%';end;if not denied then raise exception 'FAILED: unpaid pack opened';end if;
 update public.mr_packs set stripe_session='test-session-rollback' where id=p;
 perform public.mr_confirm_pack(p,'test-session-rollback','test-payment-rollback');
 denied:=false;begin perform public.mr_open_pack(v,p);exception when others then denied:=sqlerrm like '%not found%';end;if not denied then raise exception 'FAILED: other customer opened pack';end if;
 result:=public.mr_open_pack(u,p);perform public.mr_open_pack(u,p);
 select count(*) into n from public.mr_pulls where user_id=u;if n<>1 then raise exception 'FAILED: duplicate opening';end if;
 for k in 2..10 loop
  insert into public.mr_inventory(sku,title,tier_cents) values('TEST-ROLLBACK-'||k,'Paid test card '||k,300) returning id into c;
  p2:=public.mr_reserve_pack(u,300);update public.mr_packs set stripe_session='test-session-'||k where id=p2;
  perform public.mr_confirm_pack(p2,'test-session-'||k,'test-payment-'||k);perform public.mr_open_pack(u,p2);
 end loop;
 select count(*) into n from public.mr_packs where user_id=u and kind='bonus' and milestone=10 and status='ready';if n<>1 then raise exception 'FAILED: exactly one bonus at 10';end if;
 select id into p2 from public.mr_packs where user_id=u and kind='bonus';perform public.mr_open_pack(u,p2);
 select count(*) into n from public.mr_pulls where user_id=u and kind='paid';if n<>10 then raise exception 'FAILED: bonus counted as paid';end if;
 update public.mr_memberships set paid_until=now()-interval '1 second' where user_id=u;
 denied:=false;begin perform public.mr_request_shipping(u,'{}');exception when others then denied:=sqlerrm like '%active $1/month%';end;if not denied then raise exception 'FAILED: expired member requested shipping';end if;
 update public.mr_memberships set paid_until=now()+interval '1 day' where user_id=u;
 p:=public.mr_request_shipping(u,'{"name":"TEST ONLY","line1":"Fixture","city":"Fixture","region":"Fixture","postal":"00000","country":"US"}');
 denied:=false;begin perform public.mr_request_shipping(u,'{}');exception when others then denied:=sqlerrm like '%No eligible%';end;if not denied then raise exception 'FAILED: duplicate shipment request';end if;
 denied:=false;begin perform public.mr_fulfill_shipping(u,p,'shipped','USPS','123','waived','');exception when others then denied:=sqlerrm like '%Admin access%';end;if not denied then raise exception 'FAILED: customer fulfilled order';end if;
 if has_function_privilege('authenticated','public.mr_open_pack(uuid,uuid)','EXECUTE') or has_function_privilege('anon','public.mr_reserve_pack(uuid,integer)','EXECUTE') then raise exception 'FAILED: public commerce RPC';end if;
 if has_table_privilege('authenticated','public.mr_memberships','UPDATE') or has_table_privilege('anon','public.mr_inventory','SELECT') then raise exception 'FAILED: entitlement/inventory grant';end if;
end $$;
rollback;
