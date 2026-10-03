(()=>{
 'use strict';
 const $=id=>document.getElementById(id),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let context={userId:null,member:false,pulls:[]},pool={listings:[],mine:[],history:[],next_offset:null},signature='',offset=0,loading=false,queuedRefresh=false,generation=0,selected=null,requestId=null;
 const say=s=>{if($('tradeStatus'))$('tradeStatus').textContent=s;};
 const held=()=>context.pulls.filter(p=>p.shipping_status==='held');
 const art=(p)=>p.image_url?`<img loading="lazy" src="${esc(p.image_url)}" alt="${esc(p.title)}">`:'<div class="trade-placeholder" aria-hidden="true">✦</div>';
 function close(){selected=null;requestId=null;$('tradeDialog').classList.remove('show');$('tradeDialog').setAttribute('aria-hidden','true');}
 async function refresh(reset=false){
  if(!context.userId||!context.member){pool={listings:[],mine:[],history:[],next_offset:null};render();return;}
  if(loading){queuedRefresh=true;if(reset)offset=0;return;}if(reset)offset=0;const token=generation;loading=true;say('Loading the trade pool…');$('tradeRefresh').disabled=true;
  try{const data=await MarzAccount.api('trade_pool',{offset,tier:Number($('tradeTier').value)||0});if(token!==generation)return;pool=data;render();say(data.active?`${data.listings.length} available cards on this page. Trades are one-for-one within the same pack tier.`:'Your subscription is inactive. Listings pause until you have active membership.');}
  catch(e){if(token===generation)say(e.message);}finally{loading=false;$('tradeRefresh').disabled=false;if(queuedRefresh||token!==generation){queuedRefresh=false;if(context.userId&&context.member)refresh();}}
 }
 function render(){
  const enabled=!!context.userId&&context.member;
  $('tradeGate').hidden=enabled;$('tradeControls').hidden=!enabled;
  $('tradeGate').innerHTML=`<span class="trade-lock">🔒</span><h3>${context.userId?'Subscriber trading':'Your next collector connection'}</h3><p>${context.userId?'An active $1/month subscription unlocks the trade pool.':'Create a free account to save your binder. An active $1/month subscription unlocks trading.'}</p><p class="micro">Real inventory-backed cards only. Free demo cards cannot be traded or shipped.</p><button class="btn primary" id="tradeUnlock">${context.userId?'View membership':'Create account / Sign in'}</button>`;
  if(!enabled)return;
  const previousCard=$('tradeListCard').value;
  const available=held().filter(p=>!pool.mine.some(l=>l.pull_id===p.id));
  $('tradeListCard').innerHTML='<option value="">Choose a held card</option>'+available.map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · $${p.tier_cents/100} tier</option>`).join('');
  if(available.some(p=>p.id===previousCard))$('tradeListCard').value=previousCard;
  $('tradePost').disabled=!available.length;
  $('myTradeListings').innerHTML=pool.mine.map(l=>{const p=context.pulls.find(p=>p.id===l.pull_id);return `<article class="my-trade-item"><div><b>${esc(p?.title||'Listed card')}</b><small>Open to any one held $${l.tier_cents/100}-tier card</small></div><button class="btn" data-cancel-listing="${esc(l.id)}">Withdraw</button></article>`;}).join('')||'<p class="micro">You have no active listings. Choose a card above to put it into the pool.</p>';
  $('tradePool').innerHTML=pool.listings.map(l=>`<article class="trade-card"><div class="trade-card-art">${art(l)}</div><span class="trade-tier">$${l.tier_cents/100} TIER</span><h3>${esc(l.title)}</h3><p>${esc(l.rarity)} · listed by ${esc(l.collector)}</p><button class="btn primary" data-pick-trade="${esc(l.id)}" ${held().some(p=>p.tier_cents===l.tier_cents)?'':'disabled'}>${held().some(p=>p.tier_cents===l.tier_cents)?'Choose my swap →':'Need a card in this tier'}</button></article>`).join('')||'<div class="trade-empty"><span>✦</span><h3>The pool is waiting for its first signal.</h3><p>No eligible cards on this page. Members can list their held cards here once real inventory pulls exist.</p></div>';
  $('tradePrevious').disabled=offset===0;$('tradeNext').disabled=pool.next_offset==null;$('tradePage').textContent='PAGE '+(Math.floor(offset/30)+1);
  $('tradeHistory').innerHTML=pool.history.map(t=>{const maker=t.maker_id===context.userId;return `<div class="activity-row"><span>Gave <b>${esc(maker?t.requested_title:t.offered_title)}</b> → Received <b>${esc(maker?t.offered_title:t.requested_title)}</b></span><span>${esc(new Date(t.created_at).toLocaleDateString())}</span></div>`;}).join('')||'<p class="micro">Completed trades will appear here. Your binder updates automatically after a swap.</p>';
 }
 function choose(id){selected=pool.listings.find(l=>l.id===id);if(!selected)return;requestId=crypto.randomUUID();$('tradeGive').innerHTML='<p>Choose your card below.</p>';$('tradeReceive').innerHTML=`${art(selected)}<b>${esc(selected.title)}</b><small>${esc(selected.rarity)} · $${selected.tier_cents/100} tier</small>`;$('tradeOffer').innerHTML='<option value="">Choose the card you give</option>'+held().filter(p=>p.tier_cents===selected.tier_cents).map(p=>`<option value="${esc(p.id)}">${esc(p.title)} · ${esc(p.rarity)}</option>`).join('');$('swapConsent').checked=false;$('tradeConfirm').disabled=false;$('swapStatus').textContent='';$('tradeDialog').classList.add('show');$('tradeDialog').setAttribute('aria-hidden','false');$('tradeOffer').focus();}
 async function swap(){
  const offered=held().find(p=>p.id===$('tradeOffer').value);if(!selected||!offered||!$('swapConsent').checked){$('swapStatus').textContent='Choose a card and confirm the exchange.';return;}
  const listing=selected.id,request=requestId;$('tradeConfirm').disabled=true;$('tradeClose').disabled=true;$('swapStatus').textContent='Completing the swap…';
  try{await MarzAccount.api('trade_swap',{listing_id:listing,pull_id:offered.id,request_id:request,confirmed:true});close();await MarzAccount.refresh();await refresh();say('Trade complete! Your new card is in your binder. Keep it, list it again, or request shipping.');}
  catch(e){$('swapStatus').textContent=e.message+' Refresh the pool if the card is no longer available.';}
  finally{$('tradeConfirm').disabled=false;$('tradeClose').disabled=false;}
 }
 window.MarzTrades={onAccount(next){const key=[next.userId,next.member,...next.pulls.map(p=>p.id+':'+p.shipping_status)].join('|');if(next.userId!==context.userId)pool={listings:[],mine:[],history:[],next_offset:null};context=next;if(key!==signature){signature=key;generation++;close();if(!next.userId||!next.member){pool={listings:[],mine:[],history:[],next_offset:null};render();}else{render();refresh(true);}}}};
 document.addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  if(b.id==='tradeUnlock'){if(!context.userId)$('accountNav').click();else{$('membership').scrollIntoView({behavior:'smooth',block:'center'});}}
  if(b.id==='tradeClose'&&!b.disabled)close();
  if(b.id==='tradeRefresh')refresh();
  if(b.id==='tradeNext'&&pool.next_offset!=null){offset=pool.next_offset;refresh();}
  if(b.id==='tradePrevious'&&offset>0){offset=Math.max(0,offset-30);refresh();}
  if(b.dataset.pickTrade)choose(b.dataset.pickTrade);
  if(b.dataset.cancelListing){b.disabled=true;try{await MarzAccount.api('trade_cancel',{listing_id:b.dataset.cancelListing});await refresh();say('Listing withdrawn. The card stays in your binder.');}catch(e){say(e.message);await refresh();}finally{b.disabled=false;}}
  if(b.id==='tradePost'){
   const id=$('tradeListCard').value;if(!id||!$('listingConsent').checked)return say('Choose a card and authorize its same-tier swap before listing.');
   b.disabled=true;try{await MarzAccount.api('trade_list',{pull_id:id,consent:true});$('listingConsent').checked=false;await refresh();say('Card listed. Another subscriber may now exchange any one held card from the same tier for it.');}catch(e){say(e.message);}finally{b.disabled=false;}
  }
  if(b.id==='tradeConfirm')swap();
 });
 $('tradeTier').addEventListener('change',()=>refresh(true));
 $('tradeOffer').addEventListener('change',()=>{const p=held().find(p=>p.id===$('tradeOffer').value);$('tradeGive').innerHTML=p?`${art(p)}<b>${esc(p.title)}</b><small>${esc(p.rarity)} · $${p.tier_cents/100} tier</small>`:'<p>Select the card you give.</p>';});
 document.addEventListener('keydown',e=>{if(!$('tradeDialog').classList.contains('show'))return;if(e.key==='Escape'&&!$('tradeClose').disabled)close();if(e.key==='Tab'){const nodes=[...$('tradeDialog').querySelectorAll('button,input,select')].filter(n=>!n.disabled&&n.getClientRects().length);const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}});
 setInterval(()=>{if(context.member&&!document.hidden)refresh();},30000);render();
})();
