const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
let currentCategory = "الكل", searchTerm = "", toastTimer;
const safe = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
function toast(msg){const el=$("#toast");el.textContent=msg;el.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.classList.remove("show"),2800)}
function dateLabel(v){const d=new Date(v);return isNaN(d)? "وقت النشر غير محدد":d.toLocaleString("ar-EG",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}
function card(n){const image=n.image_url ? `<img loading="lazy" src="${safe(n.image_url)}" alt="${safe(n.title)}" onerror="this.parentElement.innerHTML='<div class=&quot;image-fallback&quot;>⚽</div>'">` : '<div class="image-fallback">⚽</div>';
return `<article class="news-card"><div class="news-image">${image}<span class="category-tag">${safe(n.category||"عالمي")}</span></div><div class="news-body"><h3>${safe(n.title)}</h3><p>${safe((n.summary||"تابع التفاصيل من المصدر الأصلي.").slice(0,190))}</p><div class="news-meta"><span>${safe(n.source_name||"R2 NEWS")} · ${dateLabel(n.published_at)}</span>${n.source_url && /^https?:/i.test(n.source_url)?`<a href="${safe(n.source_url)}" target="_blank" rel="noopener noreferrer">المصدر ↗</a>`:""}</div></div></article>`}
async function loadNews(){
 const grid=$("#newsGrid");grid.innerHTML='<div class="loading"><span class="spinner"></span> بنحدّث الأخبار...</div>';
 try{
  const params=new URLSearchParams();if(currentCategory!=="الكل")params.set("category",currentCategory);if(searchTerm)params.set("q",searchTerm);
  const res=await fetch("/api/news?"+params);if(!res.ok)throw Error();const news=await res.json();
  grid.innerHTML=news.length?news.map(card).join(""):'<div class="empty">لسه مفيش أخبار في القسم ده.<br><small>أضف مصدر RSS من لوحة الإدارة أو حاول لاحقًا.</small></div>';
  $("#statusText").textContent=`تم تحميل ${news.length} خبرًا من قاعدة الأخبار المتاحة.`;
  $("#tickerTrack").textContent=news.slice(0,8).map(n=>"⚽ "+n.title).join("　　◆　　")||"R2 NEWS — أضف مصادر الأخبار لبدء التحديث التلقائي.";
 }catch{grid.innerHTML='<div class="empty">تعذر الاتصال بالسيرفر. تأكد من تشغيل المشروع ثم حاول مجددًا.</div>';$("#statusText").textContent="تعذر الاتصال بالسيرفر."}
}
function setCategory(c){currentCategory=c||"الكل";$$(".filter").forEach(b=>b.classList.toggle("active",b.dataset.filter===currentCategory));loadNews();$("#news").scrollIntoView({behavior:"smooth",block:"start"})}
$$("[data-filter]").forEach(b=>b.addEventListener("click",()=>setCategory(b.dataset.filter)));
$$("[data-category]").forEach(b=>b.addEventListener("click",()=>{setCategory(b.dataset.category);$("#nav").classList.remove("open")}));
let searchTimer;$("#search").addEventListener("input",e=>{searchTerm=e.target.value.trim();clearTimeout(searchTimer);searchTimer=setTimeout(loadNews,350)});
$("#refreshBtn").addEventListener("click",loadNews);
$("#year").textContent=new Date().getFullYear();
$("#menuBtn").addEventListener("click",()=>$("#nav").classList.toggle("open"));
let adminAuthed=false;
$("#adminOpen").addEventListener("click",async()=>{ $("#adminModal").classList.remove("hidden"); try{const r=await fetch("/api/admin/status");adminAuthed=(await r.json()).authenticated;}catch{}showAdmin();});
$("#closeAdmin").addEventListener("click",()=>$("#adminModal").classList.add("hidden"));
$("#adminModal").addEventListener("click",e=>{if(e.target.id==="adminModal")$("#adminModal").classList.add("hidden")});
function showAdmin(){ $("#loginPane").classList.toggle("hidden",adminAuthed);$("#adminPane").classList.toggle("hidden",!adminAuthed);if(adminAuthed)loadAdminNews();}
$("#loginForm").addEventListener("submit",async e=>{e.preventDefault();const body=Object.fromEntries(new FormData(e.target));try{const r=await fetch("/api/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});const d=await r.json();if(!r.ok)throw Error(d.error);adminAuthed=true;showAdmin();toast("تم تسجيل الدخول");}catch(err){$("#loginError").textContent=err.message}});
$("#logoutBtn").addEventListener("click",async()=>{await fetch("/api/admin/logout",{method:"POST"});adminAuthed=false;showAdmin()});
$$("[data-tab]").forEach(b=>b.addEventListener("click",()=>{ $$(".admin-tabs button").forEach(x=>x.classList.toggle("active",x===b));["write","pending","sources"].forEach(t=>$("#"+t+"Tab").classList.toggle("hidden",t!==b.dataset.tab));if(b.dataset.tab==="pending")loadAdminNews();if(b.dataset.tab==="sources")loadSources()}));
$("#newsForm").addEventListener("submit",async e=>{e.preventDefault();const f=e.target;const d=Object.fromEntries(new FormData(f));d.approved=f.elements.approved.checked;try{const r=await fetch("/api/admin/news",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});const x=await r.json();if(!r.ok)throw Error(x.error);f.reset();f.elements.source_name.value="R2 NEWS";toast("تم حفظ الخبر");loadNews();}catch(err){$("#newsError").textContent=err.message}});
async function loadAdminNews(){try{const r=await fetch("/api/admin/news");if(!r.ok)throw Error();const arr=await r.json();$("#adminNewsList").innerHTML=arr.map(n=>`<div class="admin-item"><b>${safe(n.title)}</b><p class="muted">${safe(n.category)} · ${safe(n.status||"published")}</p>${n.status==="pending"||n.approved===false?`<button class="gold-btn" onclick="approveNews('${safe(n.id)}')">اعتماد</button>`:""}<button class="outline-btn" onclick="deleteNews('${safe(n.id)}')">حذف</button></div>`).join("")||'<p class="muted">لا توجد أخبار بعد.</p>';}catch{$("#adminNewsList").textContent="سجّل الدخول لإظهار الأخبار."}}
window.approveNews=async id=>{const r=await fetch("/api/admin/news/"+encodeURIComponent(id)+"/approve",{method:"POST"});if(r.ok){toast("تم اعتماد الخبر");loadAdminNews();loadNews()}};
window.deleteNews=async id=>{if(!confirm("هل تريد حذف هذا الخبر؟"))return;const r=await fetch("/api/admin/news/"+encodeURIComponent(id),{method:"DELETE"});if(r.ok){toast("تم حذف الخبر");loadAdminNews();loadNews()}};
$("#syncBtn").addEventListener("click",async()=>{const b=$("#syncBtn");b.disabled=true;b.textContent="جارٍ جلب الأخبار...";try{const r=await fetch("/api/admin/sync",{method:"POST"});const d=await r.json();toast(`انتهى التحديث: ${d.imported||0} عنصر، ${d.failed||0} مصدر تعذّر`);loadAdminNews();loadNews()}catch{toast("تعذر تحديث المصادر")}finally{b.disabled=false;b.textContent="↻ جلب الأخبار الآن"}});
$("#sourceForm").addEventListener("submit",async e=>{e.preventDefault();const d=Object.fromEntries(new FormData(e.target));try{const r=await fetch("/api/admin/sources",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(d)});const x=await r.json();if(!r.ok)throw Error(x.error);e.target.reset();toast("تمت إضافة المصدر");loadSources()}catch(err){toast(err.message)}});
async function loadSources(){try{const r=await fetch("/api/admin/sources");if(!r.ok)throw Error();const arr=await r.json();$("#sourcesList").innerHTML=arr.map(s=>`<div class="admin-item"><b>${safe(s.name)}</b><p class="muted">${safe(s.url)}</p></div>`).join("")||'<p class="muted">لم تتم إضافة مصادر بعد. أضف رابط RSS موثوقًا.</p>'}catch{$("#sourcesList").textContent="تعذر تحميل المصادر."}}
loadNews();
setInterval(loadNews,60*1000);
