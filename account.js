(()=>{
 'use strict';
 const C=window.MARZ_CONFIG,db=window.supabase.createClient(C.url,C.key,{auth:{storageKey:'marz-rips-account-v1',persistSession:true,autoRefreshToken:true,detectSessionInUrl:true}});
 const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let user=null,profile=null,snapshot={packs:[],pulls:[],shipping:[]},settings={payments:false,sales:false,shipping:false},timer=null,saving=null,revision=null,loading=false,saveError=false,pendingDemo=null;
 const notice=s=>{if($('accountStatus'))$('accountStatus').textContent=s;window.MarzDemo?.toast(s);};
 async function api(action,extra={}){const {data:{session}}=await db.auth.getSession();const r=await fetch(C.api,{method:'POST',headers:{'Content-Type':'application/json',apikey:C.key,...(session?{Authorization:'Bearer '+session.access_token}:{})},body:JSON.stringify({action,...extra})});const d=await r.json();if(!r.ok)throw Error(d.error||'Could not complete request.');return d;}
 function member(){return snapshot.membership?.status==='active'&&Date.parse(snapshot.membership.paid_until)>Date.now();}
 function modal(open=true){$('accountDialog')?.classList.toggle('show',open);$('accountDialog')?.setAttribute('aria-hidden',String(!open));if(open)$('accountEmail')?.focus();}
 function status(s){if($('accountStatus'))$('accountStatus').textContent=s;}
 function authError(e){return /email.*rate|over_email_send_rate_limit|email rate/i.test(e.message)?'Email delivery is temporarily limited. Wait before requesting another message.':e.message;}
 async function authAction(action){const email=$('accountEmail').value.trim(),password=$('accountPassword').value;status('Working…');const buttons=[...$('accountDialog').querySelectorAll('button[data-auth]')];buttons.forEach(b=>b.disabled=true);try{
  let r;
  if(action==='signup'){if(!email||password.length<8)throw Error('Enter your email and a password of at least 8 characters.');r=await db.auth.signUp({email,password,options:{data:{display_name:$('accountUsername').value.trim().slice(0,80)||'Collector'},emailRedirectTo:location.origin+location.pathname}});if(r.error)throw r.error;status(r.data.session?'Account created and signed in.':'Check your email to verify the account. You can paste its verification code or full confirmation link below, then sign in.');}
  if(action==='signin'){r=await db.auth.signInWithPassword({email,password});if(r.error)throw r.error;status('Signed in. Loading your saved collection…');}
  if(action==='recover'){r=await db.auth.resetPasswordForEmail(email,{redirectTo:location.origin+location.pathname});if(r.error)throw r.error;$('accountRecovery').hidden=false;status('If this account exists, a reset email was sent. Paste its code or full reset link below to verify, then set a new password.');}
  if(action==='verify'||action==='verifyReset'){
   const input=$('accountCode').value.trim();let args;try{const u=new URL(input);if(u.origin!==C.url)throw Error('Use the confirmation link from your Marz account email.');const token=u.searchParams.get('token_hash')||u.searchParams.get('token');if(!token)throw Error('Link has no verification token.');const type=u.searchParams.get('type')||'email';if(!['email','signup','recovery','magiclink'].includes(type))throw Error('Wrong verification link type.');args={token_hash:token,type};}catch(e){if(input.startsWith('http'))throw e;args={email,token:input,type:action==='verifyReset'?'recovery':'signup'};}
   r=await db.auth.verifyOtp(args);if(r.error)throw r.error;status('Verified. You are signed in.');if(action==='verifyReset')$('accountRecovery').hidden=false;
  }
  if(action==='password'){const next=$('newPassword').value;if(next.length<8)throw Error('Use at least 8 characters.');r=await db.auth.updateUser({password:next});if(r.error)throw r.error;$('newPassword').value='';status('Password saved. Use it next time you sign in.');}
 }catch(e){status(authError(e));}finally{buttons.forEach(b=>b.disabled=false);}}
 async function loadAccount(){
  if(loading||!user)return;loading=true;const id=user.id;
  try{
   let r=await db.from('mr_profiles').select('*').eq('user_id',id).maybeSingle();if(r.error)throw r.error;
   if(!r.data){r=await db.from('mr_profiles').insert({user_id:id,display_name:user.user_metadata?.display_name||'Collector'}).select().single();if(r.error)throw r.error;}
   if(user?.id!==id)return;profile=r.data;revision=profile.updated_at;saveError=false;snapshot=await api('snapshot');
   if(window.MarzDemo){const saved=profile.demo_data;window.MarzDemo.restore(Array.isArray(saved?.pulls)?saved:{pulls:[],member:false,streak:0,lastVisit:'',lastRip:'',shippingRequests:0,firstUpgradeUsed:false});}
   render();const pending=localStorage.getItem('marz-rips-unsynced-'+id);status(pending?'This device has unsynced demo progress. Use Recover unsynced progress to restore it.':'Signed in. Account progress saves online.');if(pending)notice('Unsynced demo progress is available to recover on this device.');
  }catch(e){notice('Account could not load: '+e.message+' Your local demo is unchanged.');}finally{loading=false;}
 }
 async function saveProfile(data){
  if(!user||!profile||loading||saveError)return;const id=user.id,expected=revision;
  const r=await db.from('mr_profiles').update({...data,updated_at:new Date().toISOString()}).eq('user_id',id).eq('updated_at',expected).select('updated_at');
  if(r.error)throw r.error;if(!r.data.length){saveError=true;throw Error('Your account changed on another device. Reload before saving more progress.');}if(user?.id===id)revision=r.data[0].updated_at;
 }
 function queueSave(data){const id=user?.id;if(!id||!profile||loading)return;pendingDemo=data;try{localStorage.setItem('marz-rips-unsynced-'+id,JSON.stringify({data,revision}));}catch{}clearTimeout(timer);timer=setTimeout(()=>{saving=(saving||Promise.resolve()).catch(()=>{}).then(async()=>{if(user?.id!==id)return;try{await saveProfile({demo_data:data});if(pendingDemo===data){pendingDemo=null;try{localStorage.removeItem('marz-rips-unsynced-'+id);}catch{}}if($('cloudState'))$('cloudState').textContent='Saved to your account';}catch(e){if($('cloudState'))$('cloudState').textContent='Save failed — '+e.message;notice(e.message);}});},350);if($('cloudState'))$('cloudState').textContent='Saving to your account…';}
 async function refresh(){if(!user)return;try{snapshot=await api('snapshot');render();}catch(e){notice(e.message);}}
 async function checkout(kind,tier){if(!user){modal();status('Create a free account or sign in first.');return;}if(!$('purchaseDisclosure')?.checked){notice('Read and accept the digital-card and shipping disclosure first.');return;}try{const d=await api('checkout',{kind,tier,disclosure_accepted:true});location.assign(d.url);}catch(e){notice(e.message);}}
 async function openReady(id){try{const d=await api('open',{pack_id:id});await refresh();window.MarzDemo?.showVerified(d.pull);}catch(e){notice(e.message);}}
 function render(){
  if($('accountNav'))$('accountNav').textContent=user?'My account':'Sign in';
  if($('adminLink'))$('adminLink').hidden=!snapshot.admin;
  if($('accountIdentity'))$('accountIdentity').textContent=user?`${profile?.display_name||'Collector'} · ${user.email}`:'Free accounts for every collector. Membership is optional.';
  if($('cloudState'))$('cloudState').textContent=user?(saveError?'Reload needed before cloud saving':'Saved to your account'):'Guest demo saves on this device. Sign in to save across devices.';
  if($('signOut'))$('signOut').hidden=!user;
  if($('memberButton')){$('memberButton').textContent=member()?'Manage membership':settings.payments&&settings.sales?'Subscribe · $1/month':'Membership checkout coming soon';$('memberState').textContent=member()?'Active subscription · $1 packs unlocked':'Subscription required for $1 packs and physical shipping. No charge until checkout is available.';}
  if($('holdBox')){$('holdBox').className='holdbox'+(member()?' active':'');$('holdBox').innerHTML=`<span class="holdicon">${member()?'📦':'🔒'}</span><strong>${snapshot.pulls.filter(p=>p.shipping_status==='held').length} DIGITAL COLLECTIBLES HELD</strong><small>Physical shipping requires active membership. Shipping is charged separately.</small>`;}
  if($('shippingButton')){$('shippingButton').textContent='Request physical shipping';$('shippingButton').disabled=!user||!member()||!settings.shipping||!snapshot.pulls.some(p=>p.shipping_status==='held');}
  const paid=snapshot.pulls.filter(p=>p.kind==='paid').length;
  if($('loyaltyText'))$('loyaltyText').textContent=`${paid} paid packs opened · ${10-paid%10} to your next $1 bonus pack. Demo and bonus opens do not count.`;
  if($('readyPacks'))$('readyPacks').innerHTML=snapshot.packs.filter(p=>p.status==='ready').map(p=>`<button class="btn primary" data-open="${esc(p.id)}">Rip ${p.kind==='bonus'?'earned bonus':'paid'} $${p.tier_cents/100} pack</button>`).join('')||'<p class="micro">Your purchased and earned packs will appear here after payment is verified.</p>';
  if($('digitalBinder')){
   const folders=profile?.folders||[];const filter=$('folderFilter')?.value||'';const visible=snapshot.pulls.filter(p=>!filter||folders.find(f=>f.id===filter)?.pulls?.includes(p.id));
   $('digitalBinder').innerHTML=visible.map(p=>`<article class="digital-card">${p.image_url?`<img loading="lazy" src="${esc(p.image_url)}" alt="${esc(p.title)}">`:'<div class="card-signal">✦</div>'}<b>${esc(p.title)}</b><small>${esc(p.rarity)} · ${esc(p.kind)} · DIGITAL</small><small>${esc(p.shipping_status)}</small><label>Folder<select data-folder-pull="${esc(p.id)}"><option value="">Unfiled</option>${folders.map(f=>`<option value="${esc(f.id)}" ${f.pulls?.includes(p.id)?'selected':''}>${esc(f.name)}</option>`).join('')}</select></label></article>`).join('')||'<p class="micro">No real inventory pulls yet. Demo pulls are shown in your demo binder below.</p>';
   if($('folderFilter')){$('folderFilter').innerHTML='<option value="">All cards</option>'+folders.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join('');$('folderFilter').value=filter;}
  }
  if($('shippingHistory'))$('shippingHistory').innerHTML=snapshot.shipping.map(s=>`<p><b>${esc(s.status)}</b> · ${s.pull_ids.length} cards · ${esc(s.fee_status)} ${s.tracking?'· '+esc(s.carrier)+' '+esc(s.tracking):''}</p>`).join('');
  window.MarzDemo?.renderPacks();
  if(typeof window.renderMarzAdmin==='function')window.renderMarzAdmin(snapshot.admin,user);
 }
 window.MarzAccount={api,db,member,checkout,refresh,saveDemo:queueSave,render,isSignedIn:()=>!!user,canBuy:()=>!!user&&settings.payments&&settings.sales,openReady};
 document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.dataset.auth)return authAction(b.dataset.auth);
  if(b.id==='accountNav'||b.id==='createAccount')modal();if(b.id==='closeAccount')modal(false);
  if(b.id==='signOut'){clearTimeout(timer);if(saving)await saving;if(pendingDemo){try{await saveProfile({demo_data:pendingDemo});localStorage.removeItem('marz-rips-unsynced-'+user.id);pendingDemo=null;}catch(e){notice('Save failed. A local recovery copy is retained: '+e.message);}}await db.auth.signOut();return;}
  if(b.dataset.open)return openReady(b.dataset.open);
  if(b.id==='memberButton'){if(member()){try{location.assign((await api('portal')).url);}catch(e){notice(e.message);}}else checkout('membership');}
  if(b.id==='recoverDemo'&&user){try{const saved=JSON.parse(localStorage.getItem('marz-rips-unsynced-'+user.id)||'null');if(!saved)return notice('No unsynced account progress on this device.');if(!confirm('Recover this device’s unsynced demo progress? This replaces account demo progress only.'))return;await saveProfile({demo_data:saved.data});pendingDemo=null;localStorage.removeItem('marz-rips-unsynced-'+user.id);window.MarzDemo.restore(saved.data);notice('Unsynced demo recovered.');}catch(e){notice(e.message);}}
  if(b.id==='newFolder'){const name=$('folderName').value.trim();if(!name||!profile)return;const folders=[...(profile.folders||[]),{id:crypto.randomUUID(),name:name.slice(0,60),pulls:[]}];if(folders.length>50)return notice('Maximum 50 folders.');try{await saveProfile({folders});profile.folders=folders;$('folderName').value='';render();}catch(e){notice(e.message);}}
  if(b.id==='importDemo'&&user){const data=window.MarzDemo?.guest();if(!data?.pulls?.length)return notice('No guest progress to import.');if(!confirm('Import this device’s guest demo into this account? This replaces the account demo progress, not real cards or rewards.'))return;try{await saveProfile({demo_data:data});profile.demo_data=data;window.MarzDemo.restore(data);notice('Guest demo imported. No paid rewards were awarded.');}catch(e){notice(e.message);}}
 });
 $('folderFilter')?.addEventListener('change',render);
 $('digitalBinder')?.addEventListener('change',async e=>{const id=e.target.dataset.folderPull;if(!id||!profile)return;const folders=profile.folders.map(f=>({...f,pulls:(f.pulls||[]).filter(p=>p!==id)}));folders.find(f=>f.id===e.target.value)?.pulls.push(id);try{await saveProfile({folders});profile.folders=folders;render();}catch(e){notice(e.message);}});
 $('shippingForm')?.addEventListener('submit',async e=>{e.preventDefault();const address=Object.fromEntries(new FormData(e.target));try{const d=await api('shipping',{address});notice(d.message);e.target.reset();await refresh();}catch(e){notice(e.message);}});
 const oldShipping=window.requestShipping;window.requestShipping=()=>{if(!user){modal();return;}if(!member()){notice('Physical shipping requires an active $1/month membership.');return;}if(!settings.shipping){notice('Physical shipping is not open yet.');return;}$('shippingDetails').hidden=false;$('shippingDetails').scrollIntoView({behavior:'smooth'});};
 window.toggleMember=()=>checkout('membership');
 db.auth.onAuthStateChange((event,session)=>{const previous=user?.id;user=session?.user||null;if(previous!==user?.id){clearTimeout(timer);profile=null;pendingDemo=null;snapshot={packs:[],pulls:[],shipping:[]};if(!user){window.MarzDemo?.restore(window.MarzDemo.guest());render();}else setTimeout(loadAccount,0);}if(event==='PASSWORD_RECOVERY'){modal();$('accountRecovery').hidden=false;status('Verified reset link. Enter your new password.');}});
 (async()=>{try{settings=await api('status');render();}catch(e){notice('Account service unavailable. Demo play remains available.');}const {data:{session}}=await db.auth.getSession();user=session?.user||null;if(user)await loadAccount();else render();if(new URLSearchParams(location.search).get('checkout')==='success')notice('Checking payment confirmation. Your packs unlock after the provider verifies payment.');})();
 setInterval(()=>{if(user&&!document.hidden)refresh();},60000);
})();
