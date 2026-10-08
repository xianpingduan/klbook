// Three collection variants on the existing prototype route convention.
// All changes are in-memory mock state. Never request APIs or use browser persistence.
const variants = {
  A: { name: '分步精简', caption: '推荐 · 保留两步，收起选填', note: '保留「框题 → 选学科 → 保存」。主要按钮固定在底部，其他资料按需展开。' },
  B: { name: '图片优先', caption: '大图 + 底部操作面板', note: '让题目占据页面中心。学科与保存集中到底部，补充信息在抽屉中填写。' },
  C: { name: '一页收集', caption: '框题与选学科放在同一页', note: '框题后直接选学科保存，少一次页面切换；同一页也会承担更多操作。' }
};
const params = new URLSearchParams(location.search);
const state = {
  variant: variants[params.get('variant')] ? params.get('variant') : 'A',
  step: ['collect', 'crop', 'confirm', 'detail', 'home', 'mine'].includes(params.get('step')) ? params.get('step') : 'confirm',
  size: ['phone', 'tablet', 'desktop'].includes(params.get('size')) ? params.get('size') : 'phone',
  subject: '数学', source: '', note: '', year: '2026—2027', grade: '小学四年级', term: '上学期',
  pageNumber: '', questionNumber: '', reading: '', answers: false,
  region: { x: .055, y: .24, w: .89, h: .42 },
  draft: true, canceled: false, saved: false, editing: false, pending: 1, page: 1,
  image: 0, sheet: '', toast: '', ocr: false
};
const app = document.querySelector('#app');
let toastTimer;
let toastText = '';
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function icon(name) {
  const paths = {
    back: '<path d="m14 5-7 7 7 7"/>', right: '<path d="m9 5 7 7-7 7"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>', check: '<path d="m5 12 4 4L19 6"/>',
    camera: '<path d="M4 6h4l2-3h4l2 3h4a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1Z"/><circle cx="12" cy="12" r="4"/>',
    album: '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/>',
    home: '<path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/>',
    collect: '<rect x="3" y="4" width="18" height="17" rx="3"/><path d="M8 2v4M16 2v4M8 13h8M12 9v8"/>',
    mine: '<circle cx="12" cy="7" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>',
    edit: '<path d="m4 16 12-12 4 4L8 20H4Z"/><path d="m13 7 4 4"/>',
    book: '<path d="M3 4h7l2 2 2-2h7v16h-7l-2 1-2-1H3Z"/><path d="M12 6v15"/>',
    plus: '<path d="M12 5v14M5 12h14"/>'
  };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.more}</svg>`;
}
function paper(cropped = false) {
  const r = state.region;
  const view = cropped ? `${r.x * 640} ${r.y * 780} ${r.w * 640} ${r.h * 780}` : '0 0 640 780';
  return `<svg viewBox="${view}" role="img" aria-label="示例数学材料，长方形周长练习"><rect width="640" height="780" fill="#fffef8"/>
    <g font-family="Microsoft YaHei, sans-serif" fill="#435347"><text x="38" y="56" font-size="24" font-weight="600">四年级数学 · ${state.image % 2 ? '单元练习' : '周末练习'}</text><text x="38" y="89" font-size="14" fill="#a0a393">班级：四（2）班　　　　姓名：小禾</text><path d="M38 108h564" stroke="#d5dccf"/>
    <text x="38" y="149" font-size="19">1. 直接写出得数。</text><text x="65" y="184" font-size="18">360 ÷ 6 =　　　　25 × 4 =　　　　72 ÷ 8 =</text>
    <text x="38" y="225" font-size="20" font-weight="600">2. 一块长方形菜地，长 16 米，宽 8 米。</text><text x="65" y="261" font-size="20">如果四周围上篱笆，至少需要多少米？</text>
    <rect x="158" y="325" width="292" height="127" fill="#f4f7ed" stroke="#728a6b" stroke-width="2"/><path d="M169 335h270v105H169Z" fill="none" stroke="#c5d2b9" stroke-dasharray="6 6"/><text x="280" y="309" font-size="19" fill="#708064">16 米</text><text x="462" y="395" font-size="19" fill="#708064">8 米</text><text x="65" y="491" font-size="16" fill="#a7afa1">先想一想：需要求的是周长，还是面积？</text>
    <text x="76" y="549" font-size="22" fill="#6086ac" font-style="italic">16 × 8 = 128（米）</text><path d="m344 526 24 27m0-27-24 27" stroke="#cf7768" stroke-width="3"/><text x="396" y="548" font-size="21" fill="#bd6b5d">求周长</text>
    <path d="M38 585h564" stroke="#e2e6dc"/><text x="38" y="631" font-size="20">3. 一个正方形的边长是 12 厘米，</text><text x="65" y="665" font-size="20">它的周长是多少厘米？</text><text x="294" y="748" font-size="13" fill="#b8bcb3">— 3 —</text></g></svg>`;
}
function action(label, name, classes = 'text-button') { return `<button class="${classes}" data-action="${name}">${label}</button>`; }
function head(title, subtitle = '') {
  return `<header class="app-head">${action(icon('back'), 'back', 'icon-button" aria-label="返回')}<div class="head-title"><h2>${title}</h2>${subtitle ? `<small>${subtitle}</small>` : ''}</div>${action(icon('more'), 'menu', 'icon-button" aria-label="更多操作')}</header>`;
}
function brand() { return '<header class="app-head"><div class="app-brand"><span class="logo">记</span><div><strong>错题集</strong><small>一点点整理，一点点进步</small></div></div><span class="status-dot">已连接</span></header>'; }
function footer(label, name) { return `<footer class="app-footer"><div class="footer-status">${state.saved && !state.editing ? '已同步到家庭电脑' : '整理进度已保留'}</div>${action(label, name, 'primary')}</footer>`; }
function tabs(current) { return `<nav class="app-tabs" aria-label="学习端导航">${[['home','首页'],['collect','收集'],['mine','我的']].map(([key,label])=>`<button data-action="tab-${key}" aria-current="${current===key?'page':'false'}"><span class="tab-icon">${icon(key)}</span>${label}</button>`).join('')}</nav>`; }
function subject() { return `<div class="subject-area"><label id="subject-label">这是什么学科？</label><div class="subject-chips" role="group" aria-labelledby="subject-label">${['语文','数学','英语','科学'].map(s=>`<button data-subject="${s}" aria-pressed="${s===state.subject}">${s}</button>`).join('')}</div></div>`; }
function input(label, key, placeholder = '') { return `<label>${label}<input data-field="${key}" value="${esc(state[key])}" placeholder="${placeholder}"></label>`; }
function fields() { return `<div class="fields"><label>来源<select data-field="source">${['','课堂作业','周末练习','单元试卷'].map(s=>`<option value="${s}" ${state.source===s?'selected':''}>${s||'暂不填写'}</option>`).join('')}</select></label><label>备注<textarea data-field="note" placeholder="记一句也可以，比如：把周长当成面积了">${esc(state.note)}</textarea></label><div class="two-fields">${input('页码','pageNumber','选填')}${input('题号','questionNumber','选填')}</div><label>学习阶段<select data-field="grade">${['小学三年级','小学四年级','小学五年级'].map(s=>`<option ${state.grade===s?'selected':''}>${s}</option>`).join('')}</select></label><div class="two-fields">${input('学年','year')}${input('学期','term')}</div></div>`; }
function tools() { return `<div class="tools-list">${action('补充同一道题的图片'+icon('plus'),'append')}${action('关联阅读材料'+icon('book'),'reading')}${action((state.answers?'查看已补充的答案':'补充纸质答案')+icon('edit'),'answers')}</div>`; }
function extras() { return `<details class="optional"><summary>补充信息 <small>来源、备注等</small></summary>${fields()}</details><details class="optional"><summary>更多整理 <small>跨页、原文、答案</small></summary>${tools()}</details><details class="optional"><summary>识别文字 <small>选看</small></summary><div class="ocr-result"><p>示例识别结果，保存不需要等待识别。</p><textarea aria-label="示例识别文字">一块长方形菜地，长16米，宽8米。如果四周围上篱笆，至少需要多少米？</textarea><p>请对照原图查看，识别内容可能有误。</p></div></details>`; }
function cropStage() { return `<div class="crop-stage" id="crop-stage" aria-label="在图片上拖动框住题目">${paper()}<div class="crop-selection" style="left:${state.region.x*100}%;top:${state.region.y*100}%;width:${state.region.w*100}%;height:${state.region.h*100}%"><span class="crop-label">这道题</span></div></div>`; }
function cropTools() { return `<div class="crop-under"><small>拖动重新框选题目</small>${action('换图','replace')}</div><details class="optional"><summary>调整图片 <small>整页、补图</small></summary><div class="tools-list">${action('使用整页','whole')}${action('补充同一道题的图片'+icon('plus'),'append')}</div></details>`; }
function VariantA() {
  if (state.step === 'crop') return `${head('框住这道题','第 1 步，共 2 步')}<main class="app-scroll"><p class="crop-instruction">留下完整题目，其他部分可以不框。</p>${cropStage()}${cropTools()}</main>${footer('下一步'+icon('right'),'next')}`;
  return `${head('确认并保存','第 2 步，共 2 步')}<main class="app-scroll"><div class="confirm-columns"><div><div class="paper-card">${paper(true)}</div><div class="paper-tools"><span>已选中题目范围</span>${action('调整范围','adjust')}</div></div><div>${subject()}${extras()}</div></div></main>${footer(state.editing?'保存修改':'保存到错题集','save')}`;
}
function VariantB() {
  if (state.step === 'crop') return `${head('框住这道题','第 1 步，共 2 步')}<main class="app-scroll"><p class="crop-instruction">拖动边框，留下你要收集的这道题。</p>${cropStage()}<div class="crop-under">${action('图片选项','crop-options')}${action('换图','replace')}</div></main>${footer('下一步'+icon('right'),'next')}`;
  return `${head('看看这道题','第 2 步，共 2 步')}<main class="app-scroll confirm-scroll"><div class="confirm-hero"><div class="paper-card">${paper(true)}</div><div class="paper-tools"><span>题目范围已确认</span>${action('调整范围','adjust')}</div></div></main><footer class="app-footer confirm-footer"><div class="panel-top"><strong>确认学科，就收好了</strong>${action('补充信息','supplement')}</div>${subject()}<div class="panel-bottom"><span>整理进度已保留</span>${action('识别文字','ocr')}</div>${action(state.editing?'保存修改':'保存到错题集','save','primary')}</footer>`;
}
function VariantC() {
  return `${head('收好这道题','框题 · 选学科 · 保存')}<main class="app-scroll"><div class="unified-layout"><div><p class="crop-instruction">框住题目，就能直接保存。</p>${cropStage()}<div class="crop-under">${action('调整图片','crop-options')}${action('换图','replace')}</div></div><div class="unified-info">${subject()}<details class="optional"><summary>补充信息 <small>选填</small></summary>${fields()}${tools()}</details></div></div></main>${footer(state.editing?'保存修改':'保存到错题集','save')}`;
}
function draftCard() { return `<button class="draft-card" data-action="resume"><span class="thumb">${paper()}</span><span><strong>周末练习 · 第 ${state.page} 张</strong><small>进度已保留，接着整理就好</small></span>${icon('right')}</button>`; }
function entry() { return `${brand()}<main class="app-scroll"><div class="entry-content"><div class="welcome"><h1>收集</h1><p>先留住这道题，慢慢弄懂它。</p></div><div class="capture-options"><button class="capture-card" data-action="camera">${icon('camera')}<strong>拍照</strong><small>拍下纸上的题目</small></button><button class="capture-card" data-action="album">${icon('album')}<strong>相册</strong><small>可以一次选多张</small></button></div><div class="section-title"><h3>接着整理</h3><span>${state.draft?'1 份材料':'暂无'}</span></div>${state.draft?draftCard():'<p class="empty">没有待整理的材料</p>'}${state.canceled?`<details class="optional" style="margin-top:24px"><summary>已取消的收集 <small>1 份</small></summary><div class="cancel-row"><span>周末练习 · 第 ${state.page} 张</span>${action('撤销取消','undo')}</div></details>`:''}</div></main>${tabs('collect')}`; }
function detail() { return `${head('这道题','错题集')}<main class="app-scroll"><div class="detail-content">${state.saved?`<div class="success-note">${icon('check')}这道题，收好了。</div>`:''}<div class="detail-label"><span class="subject-badge">${esc(state.subject)}</span><small>今天 · ${esc(state.grade)}</small></div><div class="paper-card">${paper(true)}</div><div class="detail-toolbar"><span>资料已保留，可随时补充</span>${action('编辑资料','edit')}</div><dl class="detail-meta"><dt>来源</dt><dd>${esc(state.source||'暂未填写')}</dd><dt>备注</dt><dd>${esc(state.note||'想到什么，再回来记一句。')}</dd></dl><details class="optional"><summary>原始材料 <small>查看整页</small></summary><div class="paper-card">${paper()}</div></details></div></main>${footer(state.pending?'继续下一张'+icon('right'):'完成','after-save')}`; }
function home() { return `${brand()}<main class="app-scroll"><div class="entry-content"><div class="welcome"><h1>我的错题</h1></div><div class="encouragement"><strong>不会的题，可以慢慢弄懂。</strong><p>愿意再想一次，就是一点进步。</p></div><button class="draft-card" data-action="open-detail"><span class="thumb">${paper(true)}</span><span><strong>${esc(state.subject)} · 长方形的周长</strong><small>今天收集 · 周末练习</small></span>${icon('right')}</button></div></main>${tabs('home')}`; }
function mine() { return `${brand()}<main class="app-scroll"><div class="entry-content"><div class="welcome"><h1>我的</h1></div><div class="paper-card"><div class="section-title"><h3>家庭资料库</h3><span>已连接</span></div><p class="muted" style="font-size:12px">资料保存在家里的电脑上</p></div><p class="subtle-caption">本次预览只展示收集交互。</p></div></main>${tabs('mine')}`; }
function sheet() {
  if (!state.sheet) return '';
  let title = '', body = '';
  if (state.sheet === 'menu') {
    title = '更多操作'; body = `${action('查看原始页'+icon('right'),'original','menu-item')}${!state.saved?action('取消本次收集','cancel','menu-item danger'):action('从这页再收集一道'+icon('right'),'another','menu-item')}<p class="sheet-hint" style="margin-top:16px">${state.saved?'原始材料会保留，方便以后再查看。':'返回会保留整理进度；取消本次后仍可撤销。'}</p>`;
  } else if (state.sheet === 'supplement') { title='补充资料'; body=`<p class="sheet-hint">现在不填写也可以，保存后随时能补。</p>${fields()}<details class="optional"><summary>更多整理</summary>${tools()}</details>${action('完成','close-sheet','primary')}`;
  } else if (state.sheet === 'crop-options') { title='调整图片'; body=`${action('使用整页','whole','menu-item')}${action('补充同一道题的图片','append','menu-item')}`;
  } else if (state.sheet === 'original') { title='原始页'; body=`<div class="paper-card">${paper()}</div>`;
  } else if (state.sheet === 'ocr') { title='识别文字'; body='<p class="sheet-hint">示例识别结果 · 不影响保存题目</p><p style="font-size:14px">一块长方形菜地，长16米，宽8米。如果四周围上篱笆，至少需要多少米？</p>';
  } else if (state.sheet === 'reading') { title='关联阅读材料'; body=`<p class="sheet-hint">多个小题可以共用同一篇原文。</p><div class="fields"><label>阅读材料<select data-field="reading">${['','秋天的田野','A day at school'].map(s=>`<option value="${s}" ${state.reading===s?'selected':''}>${s||'不关联阅读材料'}</option>`).join('')}</select></label></div>${action('完成','close-sheet','primary')}`;
  } else if (state.sheet === 'answers') { title='纸质答案'; body=`<p class="sheet-hint">可以之后再补，不影响先收好题目。</p><div class="paper-card" style="padding:24px"><p style="font-size:15px;color:#71875f">（16 ＋ 8）× 2 ＝ 48（米）</p><p class="subtle-caption">示例纸质答案</p></div>${action('使用这份示例答案','use-answer','primary')}`;
  } else if (state.sheet === 'append') { title='补充同一道题的图片'; body=`<p class="sheet-hint">用于跨页题或同一页上分开的题目区域。</p><div class="paper-card">${paper(true)}</div>${action('添加这张示例图片','use-append','primary')}`;
  }
  return `<div class="overlay" data-dismiss="true"><section class="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"><div class="sheet-head"><strong id="sheet-title">${title}</strong>${action(icon('close'),'close-sheet','icon-button" aria-label="关闭')}</div><div class="sheet-body">${body}</div></section></div>`;
}
function syncUrl() { const url = new URL(location.href); url.searchParams.set('variant',state.variant); url.searchParams.set('step',state.step); url.searchParams.set('size',state.size); history.replaceState(null,'',url); }
function render() {
  syncUrl(); document.body.className=`size-${state.size}`; app.className=`app variant-${state.variant}`;
  document.querySelector('#variant-label').textContent=`${state.variant} · ${variants[state.variant].name}`;
  document.querySelector('#variant-caption').textContent=variants[state.variant].caption;
  document.querySelector('#variant-note').innerHTML=`<strong>${state.variant} / ${variants[state.variant].name}</strong>${variants[state.variant].note}`;
  document.querySelectorAll('[data-size]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.size===state.size)));
  document.querySelectorAll('[data-step]').forEach(el=>el.setAttribute('aria-current',el.dataset.step===state.step?'step':'false'));
  const screens = {collect:entry,detail,home,mine};
  app.innerHTML=(screens[state.step]?screens[state.step]():({A:VariantA,B:VariantB,C:VariantC})[state.variant]())+sheet()+`<div class="toast" role="status" ${toastText?'':'hidden'}>${esc(toastText)}</div>`;
  document.querySelector('#preview-state').textContent=`${state.variant} · ${state.step} · ${state.subject} · ${state.saved?'已收集':state.canceled?'已取消':'草稿'} ｜ 内存演示，刷新重置`;
  const dialog=app.querySelector('.sheet');
  if(dialog) { app.querySelector('.app-head')?.setAttribute('inert',''); app.querySelector('.app-scroll')?.setAttribute('inert',''); app.querySelector('.app-footer')?.setAttribute('inert',''); dialog.querySelector('button')?.focus(); }
  bindCrop();
}
function toast(text) { toastText=text; clearTimeout(toastTimer); const el=app.querySelector('.toast'); if(el){el.textContent=text;el.hidden=false;} toastTimer=setTimeout(()=>{toastText='';const current=app.querySelector('.toast');if(current)current.hidden=true;},2700); }
function go(step) { state.step=step;state.sheet='';render(); }
function rotate(dir) { const keys=Object.keys(variants);state.variant=keys[(keys.indexOf(state.variant)+dir+3)%3];state.sheet='';render(); }
function start(kind) { state.draft=true;state.saved=false;state.editing=false;state.canceled=false;state.page=1;state.pending=kind==='album'?2:0;state.region={x:.055,y:.24,w:.89,h:.42};go('crop');toast(kind==='album'?'已选用 3 张示例图片':'已拍下一张示例图片'); }
function save() { state.saved=true;state.draft=false;state.editing=false;go('detail');toast('演示：题目已收集并同步'); }
const actions = {
  back:()=>go(state.step==='confirm'&&!state.editing?'crop':state.step==='detail'?'home':'collect'),
  menu:()=>{state.sheet='menu';render();},
  camera:()=>start('camera'), album:()=>start('album'), resume:()=>go('crop'),
  next:()=>{state.ocr=true;go('confirm');}, adjust:()=>go('crop'),save,
  replace:()=>{state.image++;state.region={x:.055,y:.24,w:.89,h:.42};render();toast('已换成另一张示例图片，填写信息保留');},
  cancel:()=>{state.canceled=true;state.draft=false;state.saved=false;go('collect');toast('已取消本次，可以在下方撤销');},
  undo:()=>{state.canceled=false;state.draft=true;render();toast('材料已恢复，可以接着整理');},
  'close-sheet':()=>{state.sheet='';render();},
  whole:()=>{state.region={x:0,y:0,w:1,h:1};state.sheet='';render();toast('已选择整页');},
  edit:()=>{state.editing=true;go('confirm');},
  'after-save':()=>{if(state.pending){state.pending--;state.page++;state.saved=false;state.draft=true;go('crop');toast(`接着整理第 ${state.page} 张`);}else go('home');},
  'open-detail':()=>go('detail'),
  another:()=>{state.saved=false;state.draft=true;state.pending=0;go('crop');},
  'use-answer':()=>{state.answers=true;state.sheet='';render();toast('已补充示例纸质答案');},
  'use-append':()=>{state.sheet='';render();toast('演示：已补充同一道题的图片');}
};
['supplement','crop-options','original','ocr','reading','answers','append'].forEach(key=>actions[key]=()=>{state.sheet=key;render();});
['home','collect','mine'].forEach(key=>actions[`tab-${key}`]=()=>go(key));
document.addEventListener('click',event=>{
  const target=event.target.closest('button');
  if(target?.dataset.step) {state.sheet='';state.step=target.dataset.step;if(state.step==='detail'){state.saved=true;state.draft=false;}render();}
  else if(target?.dataset.size){state.size=target.dataset.size;render();}
  else if(target?.dataset.subject){state.subject=target.dataset.subject;app.querySelectorAll('[data-subject]').forEach(el=>el.setAttribute('aria-pressed',String(el.dataset.subject===state.subject)));document.querySelector('#preview-state').textContent=`${state.variant} · ${state.step} · ${state.subject} ｜ 内存演示，刷新重置`;}
  else if(target?.dataset.action) actions[target.dataset.action]?.();
  if(event.target.classList.contains('overlay'))actions['close-sheet']();
});
document.addEventListener('input',event=>{if(event.target.dataset.field)state[event.target.dataset.field]=event.target.value;});
document.querySelector('#previous-variant').addEventListener('click',()=>rotate(-1));
document.querySelector('#next-variant').addEventListener('click',()=>rotate(1));
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&state.sheet){actions['close-sheet']();return;}
  if(state.sheet&&event.key==='Tab'){
    const focusable=[...app.querySelectorAll('.sheet button,.sheet input,.sheet select,.sheet textarea,.sheet summary')].filter(el=>el.getClientRects().length);
    const i=focusable.indexOf(document.activeElement);
    if(event.shiftKey&&i===0){event.preventDefault();focusable.at(-1)?.focus();}else if(!event.shiftKey&&i===focusable.length-1){event.preventDefault();focusable[0]?.focus();}
  }
  if(state.sheet||event.target.closest('input,textarea,select,[contenteditable="true"],#crop-stage'))return;
  if(event.key==='ArrowLeft'||event.key==='ArrowRight'){event.preventDefault();rotate(event.key==='ArrowLeft'?-1:1);}
});
function bindCrop(){
  const stage=app.querySelector('#crop-stage');if(!stage)return;
  let anchor;
  const coords=e=>{const b=stage.getBoundingClientRect();return{x:Math.max(0,Math.min(1,(e.clientX-b.x)/b.width)),y:Math.max(0,Math.min(1,(e.clientY-b.y)/b.height))};};
  stage.addEventListener('pointerdown',e=>{anchor=coords(e);stage.setPointerCapture(e.pointerId);});
  stage.addEventListener('pointermove',e=>{if(!anchor)return;const p=coords(e);const r={x:Math.min(anchor.x,p.x),y:Math.min(anchor.y,p.y),w:Math.abs(p.x-anchor.x),h:Math.abs(p.y-anchor.y)};if(r.w<.03||r.h<.03)return;state.region=r;Object.assign(stage.querySelector('.crop-selection').style,{left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.w*100}%`,height:`${r.h*100}%`});});
  stage.addEventListener('pointerup',()=>{if(anchor){anchor=null;toast('演示：框选进度已保留');}});
  stage.addEventListener('pointercancel',()=>{anchor=null;});
}
render();
