import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
const SUPA_URL=Deno.env.get('SUPABASE_URL')!,SERVICE=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const db=createClient(SUPA_URL,SERVICE,{auth:{persistSession:false,autoRefreshToken:false}});
const SITE='https://numimarz.github.io/marz-rips/';
const stripeKey=Deno.env.get('MARZ_STRIPE_SECRET_KEY'),webhookSecret=Deno.env.get('MARZ_STRIPE_WEBHOOK_SECRET');
const cors={'Access-Control-Allow-Origin':'https://numimarz.github.io','Access-Control-Allow-Headers':'authorization,apikey,content-type,x-client-info','Access-Control-Allow-Methods':'POST,OPTIONS','Vary':'Origin'};
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json','Cache-Control':'no-store'}});
function checked<T extends {error:any;data:any}>(r:T){if(r.error)throw Error(r.error.message);return r.data;}
async function stripe(path:string,method='GET',data?:Record<string,string>,idempotency?:string){
 if(!stripeKey)throw Error('Payment processing is not connected yet. No charge has been made.');
 const r=await fetch('https://api.stripe.com/v1/'+path,{method,headers:{Authorization:'Bearer '+stripeKey,'Stripe-Version':'2025-02-24.acacia',...(method==='POST'?{'Content-Type':'application/x-www-form-urlencoded'}:{}),...(idempotency?{'Idempotency-Key':idempotency}:{})},body:method==='POST'?new URLSearchParams(data):undefined});
 const d=await r.json();if(!r.ok)throw Error(d.error?.message||'Payment provider unavailable');return d;
}
async function signed(raw:string,header:string){
 if(!webhookSecret)return false;const parts=header.split(',').map(x=>x.split('=')),t=parts.find(x=>x[0]==='t')?.[1];if(!t||Math.abs(Date.now()/1000-Number(t))>300)return false;
 const k=await crypto.subtle.importKey('raw',new TextEncoder().encode(webhookSecret),{name:'HMAC',hash:'SHA-256'},false,['sign']);
 const bytes=new Uint8Array(await crypto.subtle.sign('HMAC',k,new TextEncoder().encode(t+'.'+raw)));const expected=[...bytes].map(b=>b.toString(16).padStart(2,'0')).join('');
 return parts.filter(p=>p[0]==='v1').some(p=>{if(p[1]?.length!==expected.length)return false;let diff=0;for(let i=0;i<expected.length;i++)diff|=expected.charCodeAt(i)^p[1].charCodeAt(i);return diff===0;});
}
async function syncMembership(subscriptionId:string){
 const sub=await stripe('subscriptions/'+encodeURIComponent(subscriptionId));
 if(sub.metadata?.app!=='marz-rips'||!sub.metadata?.user_id)return;
 const invoice=typeof sub.latest_invoice==='string'?await stripe('invoices/'+encodeURIComponent(sub.latest_invoice)):sub.latest_invoice;
 const validItem=sub.items?.data?.length===1&&sub.items.data[0].price.currency==='usd'&&sub.items.data[0].price.unit_amount===100&&sub.items.data[0].price.recurring?.interval==='month';
 const active=sub.status==='active'&&invoice?.status==='paid'&&validItem;
 const until=sub.current_period_end||sub.items?.data?.[0]?.current_period_end;
 checked(await db.from('mr_memberships').upsert({user_id:sub.metadata.user_id,stripe_subscription:sub.id,stripe_customer:typeof sub.customer==='string'?sub.customer:sub.customer.id,status:active?'active':sub.status,paid_until:until?new Date(until*1000).toISOString():null,updated_at:new Date().toISOString()}));
}
async function paymentEvent(e:any){
 const seen=checked(await db.from('mr_events').select('stripe_id').eq('stripe_id',e.id).maybeSingle());if(seen)return;
 const obj=e.data.object;
 if(e.type.startsWith('customer.subscription.'))await syncMembership(obj.id);
 if(e.type==='invoice.paid'||e.type==='invoice.payment_failed'){const id=obj.subscription||obj.parent?.subscription_details?.subscription;if(id)await syncMembership(id);}
 if(e.type==='checkout.session.completed'||e.type==='checkout.session.async_payment_succeeded'){
  const s=await stripe('checkout/sessions/'+encodeURIComponent(obj.id));
  if(s.metadata?.app==='marz-rips'&&s.payment_status==='paid'){
   if(s.mode==='subscription'&&s.subscription)await syncMembership(typeof s.subscription==='string'?s.subscription:s.subscription.id);
   if(s.mode==='payment'&&s.metadata.pack_id){
    const p=checked(await db.from('mr_packs').select('*').eq('id',s.metadata.pack_id).single());
    if(s.currency!=='usd'||s.amount_total!==p.tier_cents||s.client_reference_id!==p.user_id)throw Error('Payment amount or owner mismatch');
    checked(await db.rpc('mr_confirm_pack',{p_pack:p.id,p_session:s.id,p_payment:typeof s.payment_intent==='string'?s.payment_intent:s.payment_intent.id}));
   }
  }
 }
 if(e.type==='checkout.session.expired'&&obj.metadata?.app==='marz-rips'&&obj.metadata?.pack_id){const p=checked(await db.from('mr_packs').select('id,stripe_session').eq('id',obj.metadata.pack_id).maybeSingle());if(p?.stripe_session===obj.id)checked(await db.rpc('mr_expire_pack',{p_pack:p.id}));}
 if(e.type==='charge.refunded'&&obj.payment_intent){
  const p=checked(await db.from('mr_packs').select('id,user_id').eq('stripe_payment',obj.payment_intent).maybeSingle());
  if(p)checked(await db.from('mr_audit').insert({actor:p.user_id,action:'refund_review_required',record_id:p.id,details:{charge:obj.id,amount_refunded:obj.amount_refunded}}));
 }
 checked(await db.from('mr_events').insert({stripe_id:e.id,event_type:e.type}));
}
Deno.serve(async req=>{
 if(req.method==='OPTIONS')return new Response('',{headers:cors});
 if(req.method!=='POST')return json({error:'POST required'},405);
 try{
  const raw=await req.text();if(raw.length>1100000)return json({error:'Request too large'},413);
  if(new URL(req.url).searchParams.has('webhook')){
   if(!await signed(raw,req.headers.get('stripe-signature')||''))return json({error:'Invalid webhook signature'},401);
   await paymentEvent(JSON.parse(raw));return json({received:true});
  }
  const body=JSON.parse(raw||'{}');
  if(body.action==='status'){const settings=checked(await db.from('mr_settings').select('*').single());return json({payments:!!stripeKey&&!!webhookSecret,sales:settings.sales_enabled,shipping:settings.shipping_enabled});}
  const token=(req.headers.get('Authorization')||'').replace(/^Bearer /,'');
  const {data:{user},error}=await db.auth.getUser(token);if(error||!user)return json({error:'Sign in to your Marz Rips account first.'},401);
  const admin=!!checked(await db.from('mr_admins').select('user_id').eq('user_id',user.id).maybeSingle());
  const action=body.action;
  if(action==='snapshot'){
   const [membership,packs,pulls,shipping]=await Promise.all([db.from('mr_memberships').select('*').eq('user_id',user.id).maybeSingle(),db.from('mr_packs').select('id,tier_cents,kind,milestone,status,created_at').eq('user_id',user.id).in('status',['ready','awaiting_payment']).order('created_at'),db.from('mr_pulls').select('*').eq('user_id',user.id).order('opened_at',{ascending:false}),db.from('mr_shipping').select('*').eq('user_id',user.id).order('created_at',{ascending:false})]);
   return json({admin,membership:checked(membership),packs:checked(packs),pulls:checked(pulls),shipping:checked(shipping)});
  }
  if(action==='checkout'){
   if(!stripeKey||!webhookSecret)return json({error:'Subscriptions and paid packs are not open yet. Payment processing must be connected first; no charge was made.'},503);
   if(body.disclosure_accepted!==true)return json({error:'Please accept the digital-card and shipping disclosure.'},400);
   const settings=checked(await db.from('mr_settings').select('*').single());
   if(!settings.sales_enabled)return json({error:'The store is preparing inventory. Checkout is not open yet.'},409);
   const base:Record<string,string>={success_url:SITE+'?checkout=success',cancel_url:SITE+'?checkout=cancelled',client_reference_id:user.id,'metadata[app]':'marz-rips','metadata[user_id]':user.id,'line_items[0][quantity]':'1','line_items[0][price_data][currency]':'usd','line_items[0][price_data][product_data][description]':'Digital collectible reveal. Physical shipping requires an active $1/month membership; shipping costs are separate.'};
   if(user.email)base.customer_email=user.email;
   let pack:string|null=null;
   if(body.kind==='membership'){
    const current=checked(await db.from('mr_memberships').select('*').eq('user_id',user.id).maybeSingle());
    if(current?.stripe_subscription){const sub=await stripe('subscriptions/'+encodeURIComponent(current.stripe_subscription));if(!['canceled','incomplete_expired'].includes(sub.status))return json({error:'A subscription already exists. Use Manage membership instead.'},409);}
    Object.assign(base,{mode:'subscription','line_items[0][price_data][unit_amount]':'100','line_items[0][price_data][recurring][interval]':'month','line_items[0][price_data][product_data][name]':'Marz Rips membership','subscription_data[metadata][app]':'marz-rips','subscription_data[metadata][user_id]':user.id});
   }else if(body.kind==='pack'){
    pack=checked(await db.rpc('mr_reserve_pack',{p_user:user.id,p_tier:Number(body.tier)*100}));
    Object.assign(base,{mode:'payment','payment_method_types[0]':'card','line_items[0][price_data][unit_amount]':String(Number(body.tier)*100),'line_items[0][price_data][product_data][name]':'Marz Rips $'+body.tier+' digital pack','metadata[pack_id]':pack!,'expires_at':String(Math.floor(Date.now()/1000)+1800)});
   }else return json({error:'Unknown checkout type'},400);
   try{const s=await stripe('checkout/sessions','POST',base,pack||('member-'+user.id+'-'+Math.floor(Date.now()/120000)));if(pack)checked(await db.from('mr_packs').update({stripe_session:s.id}).eq('id',pack));return json({url:s.url});}
   catch(e){if(pack)await db.rpc('mr_expire_pack',{p_pack:pack});throw e;}
  }
  if(action==='portal'){const m=checked(await db.from('mr_memberships').select('stripe_customer').eq('user_id',user.id).single());const s=await stripe('billing_portal/sessions','POST',{customer:m.stripe_customer,return_url:SITE});return json({url:s.url});}
  if(action==='open')return json({pull:checked(await db.rpc('mr_open_pack',{p_user:user.id,p_pack:body.pack_id}))});
  if(action==='shipping'){
   const a=body.address;if(!a||!['name','line1','city','region','postal','country'].every(k=>typeof a[k]==='string'&&a[k].trim().length>0&&a[k].length<=200))return json({error:'Complete the shipping address.'},400);
   const id=checked(await db.rpc('mr_request_shipping',{p_user:user.id,p_address:a}));return json({id,message:'Shipping request received. Await a shipping quote; this is not a shipment confirmation.'});
  }
  if(!admin)return json({error:'Admin access required.'},403);
  if(action==='admin'){
   const result:any={};for(const table of ['mr_inventory','mr_pulls','mr_shipping','mr_packs','mr_memberships','mr_profiles','mr_audit'])result[table]=checked(await db.from(table).select(table==='mr_profiles'?'user_id,display_name,updated_at':'*').order(table==='mr_profiles'||table==='mr_memberships'?'updated_at':table==='mr_pulls'?'opened_at':'created_at',{ascending:false}).limit(500));
   const ids=[...new Set([...result.mr_profiles,...result.mr_pulls,...result.mr_shipping,...result.mr_memberships].map(x=>x.user_id))];const contacts:any={};for(const id of ids.slice(0,100)){const r=await db.auth.admin.getUserById(id as string);contacts[id as string]={email:r.data.user?.email||null};}result.contacts=contacts;
   return json(result);
  }
  if(action==='inventory'){
   const c=body.card;if(!c||!c.sku?.trim()||!c.title?.trim()||![100,300,500,900,1300].includes(Number(c.tier_cents))||!['sale','bonus'].includes(c.pool)||c.pool==='bonus'&&Number(c.tier_cents)!==100)return json({error:'Complete SKU, card name, tier and pool.'},400);
   if(c.image_url&&!/^https:\/\//.test(c.image_url))return json({error:'Card image must use HTTPS.'},400);
   const row=checked(await db.from('mr_inventory').insert({sku:c.sku.trim(),title:c.title.trim(),rarity:String(c.rarity||'COMMON').slice(0,50),tier_cents:Number(c.tier_cents),pool:c.pool,image_url:c.image_url||null}).select().single());checked(await db.from('mr_audit').insert({actor:user.id,action:'inventory_added',record_id:row.id}));return json({card:row});
  }
  if(action==='fulfill'){checked(await db.rpc('mr_fulfill_shipping',{p_admin:user.id,p_order:body.order_id,p_status:body.status,p_carrier:String(body.carrier||'').slice(0,100),p_tracking:String(body.tracking||'').slice(0,150),p_fee:body.fee_status,p_notes:String(body.notes||'').slice(0,1000)}));return json({ok:true});}
  return json({error:'Unknown action'},400);
 }catch(e){return json({error:e instanceof Error?e.message:'Request failed'},400);}
});
