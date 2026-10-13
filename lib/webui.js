// dsh-rewind —— Web UI 注入
// 1) 本地 REST：GET  /dsh-rewind/api/checkpoints[?sessionId=]
//               POST /dsh-rewind/api/restore  {sessionId?, turn, scope}
// 2) UI 注入（webserver/index-inject，apply 内同步注册）：
//    - 消息级回退按钮（默认启用）：MutationObserver 监听转写区，在每条可映射的
//      用户消息操作行注入原生样式"回退"按钮，点击 = restore(turn,'both') + 回填原文
//    - 悬浮 ⏪ 面板（panel:true 才注入，默认关闭）

export const PANEL_CSS = `
#dsh-rewind-root{position:fixed;right:18px;bottom:18px;z-index:2147483000;font-family:inherit}
#dsh-rewind-btn{width:44px;height:44px;border-radius:50%;border:none;cursor:pointer;
  background:linear-gradient(135deg,#4d6bfe,#7b5cff);color:#fff;font-size:19px;line-height:1;
  box-shadow:0 4px 14px rgba(77,107,254,.45);transition:transform .15s ease}
#dsh-rewind-btn:hover{transform:scale(1.08)}
#dsh-rewind-panel{display:none;width:380px;max-height:60vh;background:#fff;color:#1f2329;
  border:1px solid #e5e6eb;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.16);
  overflow:hidden;flex-direction:column}
#dsh-rewind-root.open #dsh-rewind-panel{display:flex}
#dsh-rewind-root.open #dsh-rewind-btn{background:#1f2329}
.dsh-rw-head{padding:10px 14px;font-weight:600;font-size:14px;border-bottom:1px solid #f0f1f3;
  display:flex;justify-content:space-between;align-items:center}
.dsh-rw-head span.dsh-rw-x{cursor:pointer;color:#86909c;font-size:16px}
.dsh-rw-list{overflow:auto;flex:1;margin:0;padding:0;list-style:none}
.dsh-rw-item{padding:9px 14px;border-bottom:1px solid #f7f8fa;cursor:pointer;font-size:12.5px}
.dsh-rw-item:hover{background:#f2f3f8}
.dsh-rw-item.sel{background:#eef1ff}
.dsh-rw-item .dsh-rw-t{font-weight:600;margin-bottom:2px}
.dsh-rw-item .dsh-rw-p{color:#4e5969;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rw-item .dsh-rw-f{color:#86909c;font-size:11.5px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dsh-rw-foot{padding:10px 14px;border-top:1px solid #f0f1f3;display:flex;gap:8px;align-items:center;font-size:12.5px}
.dsh-rw-foot select{flex:0 0 auto;padding:4px 6px;border:1px solid #e5e6eb;border-radius:6px}
.dsh-rw-foot button{flex:1;padding:6px 0;border:none;border-radius:6px;background:#4d6bfe;color:#fff;cursor:pointer}
.dsh-rw-foot button:disabled{background:#c2c7d0}
.dsh-rw-msg{padding:8px 14px;font-size:12px;color:#4e5969;min-height:16px;max-height:88px;overflow:auto}
@media (prefers-color-scheme:dark){
  #dsh-rewind-panel{background:#1e1f24;color:#e8e9ed;border-color:#33353d}
  .dsh-rw-head{border-color:#2a2c33}.dsh-rw-item{border-color:#22242a}
  .dsh-rw-item:hover{background:#26282f}.dsh-rw-item.sel{background:#2b3050}
  .dsh-rw-p{color:#b6bac4}.dsh-rw-f{color:#7d828f}
  .dsh-rw-foot{border-color:#2a2c33}.dsh-rw-foot select{background:#26282f;color:#e8e9ed;border-color:#33353d}
}`

export const PANEL_JS = `
(function(){
  if (window.__dshRewindLoaded) return; window.__dshRewindLoaded = true;
  var root=document.createElement('div');root.id='dsh-rewind-root';
  root.innerHTML='<button id="dsh-rewind-btn" title="回滚（代码/会话）">⏪</button>'
    +'<div id="dsh-rewind-panel">'
    +'<div class="dsh-rw-head"><span>回滚检查点</span><span class="dsh-rw-x" id="dsh-rw-close">✕</span></div>'
    +'<ul class="dsh-rw-list" id="dsh-rw-list"><li class="dsh-rw-item">加载中…</li></ul>'
    +'<div class="dsh-rw-foot"><select id="dsh-rw-scope">'
    +'<option value="both">代码+会话</option><option value="code">仅代码</option><option value="conversation">仅会话</option>'
    +'</select><button id="dsh-rw-go">回滚到选中轮</button></div>'
    +'<div class="dsh-rw-msg" id="dsh-rw-msg"></div></div>';
  document.body.appendChild(root);
  var sel=null, list=[], busy=false;
  var $=function(id){return document.getElementById(id)};
  function msg(t){$('dsh-rw-msg').textContent=t||''}
  $('dsh-rewind-btn').onclick=function(){root.classList.toggle('open');if(root.classList.contains('open'))load()};
  $('dsh-rw-close').onclick=function(){root.classList.remove('open')};
  function esc(s){var d=document.createElement('div');d.textContent=s==null?'':String(s);return d.innerHTML}
  function load(){fetch('/dsh-rewind/api/checkpoints',{cache:'no-store'}).then(function(r){return r.json()})
    .then(function(d){list=(d&&d.checkpoints)||[];render()})
    .catch(function(){msg('加载检查点失败')})}
  function render(){
    var ul=$('dsh-rw-list');sel=null;ul.innerHTML='';
    if(!list.length){ul.innerHTML='<li class="dsh-rw-item">本会话还没有检查点。<br>让 AI 修改文件或对话一轮后即可回滚。</li>';return}
    list.slice().reverse().forEach(function(cp){
      var li=document.createElement('li');li.className='dsh-rw-item';
      var files=(cp.files||[]).map(function(f){return (f.kind==='create'?'+ ':f.kind==='skip'?'! ':'~ ')+f.path}).join('、');
      li.innerHTML='<div class="dsh-rw-t">第 '+cp.turn+' 轮 · '+new Date(cp.time).toLocaleString()+'</div>'
        +'<div class="dsh-rw-p">'+esc(cp.prompt||'(无提示词)')+'</div>'
        +(files?'<div class="dsh-rw-f">'+esc(files)+'</div>':'');
      li.onclick=function(){var s=ul.querySelectorAll('.dsh-rw-item.sel');
        for(var i=0;i<s.length;i++)s[i].classList.remove('sel');
        li.classList.add('sel');sel=cp.turn;msg('已选第 '+sel+' 轮，将回滚到该轮之前')}
      ul.appendChild(li);
    });
  }
  $('dsh-rw-go').onclick=function(){
    if(busy)return msg('正在执行…');
    if(!sel)return msg('请先在上方选择一个轮次');
    if(!confirm('确认回滚到第 '+sel+' 轮之前？\\n受影响的文件与会话记录将一起退回（不碰 git）。'))return;
    busy=true;$('dsh-rw-go').disabled=true;msg('回滚中…');
    fetch('/dsh-rewind/api/restore',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({turn:sel,scope:$('dsh-rw-scope').value})})
      .then(function(r){return r.json()})
      .then(function(d){
        busy=false;$('dsh-rw-go').disabled=false;
        if(d&&d.ok){msg('回退成功：文件已恢复，对话将在你发送下一条消息时自动回退。');load()}
        else msg('回滚失败：'+((d&&d.error)||'未知错误'));
      })
      .catch(function(e){busy=false;$('dsh-rw-go').disabled=false;msg('请求失败：'+e)});
  };
})();`

/** 消息级回退按钮样式（主要复用原生 xD_KDq_action 类，仅补少量状态样式） */
export const MSG_CSS = `
[data-dsh-rw-btn]{color:#4d6bfe}
[data-dsh-rw-btn]:hover{color:#7b5cff}
[data-dsh-rw-btn][disabled]{opacity:.5;cursor:default}
@media (prefers-color-scheme:dark){[data-dsh-rw-btn]{color:#7b93ff}}
`

/** 消息级回退脚本：MutationObserver + 文本归一化映射 + 回填（TraeWork 式） */
export const MESSAGE_JS = `
(function(){
  if (window.__dshRewindMsgLoaded) return; window.__dshRewindMsgLoaded = true;
  var CFG = window.__DSH_REWIND_CONFIG__ || {};
  var CONFIRM = CFG.confirm !== false;
  var state = { messages: [], fetchedAt: 0, sessionId: undefined };
  function norm(s){ return (s || '').replace(/\\s+/g, '') }
  function esc(s){ var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML }
  function unhideAll(){
    ;[...document.querySelectorAll('[data-dsh-rw-hidden]')].forEach(function(el){
      el.removeAttribute('data-dsh-rw-hidden')
      el.style.display = ''
    })
  }
  function fetchState(force, cb){
    if (!force && Date.now() - state.fetchedAt < 10000) return cb && cb();
    fetch('/dsh-rewind/api/checkpoints', { cache: 'no-store' })
      .then(function(r){ return r.json() })
      .then(function(d){
        if ((d && d.sessionId) !== state.sessionId) { unhideAll() }
        state.sessionId = d && d.sessionId
        state.messages = (d && d.messages) || []
        state.checkpoints = (d && d.checkpoints) || []
        state.fetchedAt = Date.now(); cb && cb()
      })
      .catch(function(){ cb && cb() })
  }
  var RW_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5v0a5.5 5.5 0 0 1-5.5 5.5H11"/></svg>'
  function cutStorageKey(){ return 'dsh-rw-cut:' + (state.sessionId || '') }
  function openModal(opts){
    // 与桌面端一致的暗色模态（替代原生 confirm）；先清残留，避免旧模态吞掉后续弹窗
    var stale = document.getElementById('dsh-rw-modal')
    if (stale) stale.remove()
    var overlay = document.createElement('div')
    overlay.id = 'dsh-rw-modal'
    overlay.setAttribute('data-dsh-rw-confirm', '1')
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:2147483646;display:flex;align-items:center;justify-content:center'
    var card = document.createElement('div')
    card.style.cssText = 'background:#202124;color:#e6e6e6;border:1px solid rgba(255,255,255,.1);border-radius:12px;padding:20px;width:440px;max-width:92vw;max-height:80vh;overflow:auto;box-shadow:0 16px 48px rgba(0,0,0,.55);font-family:system-ui,-apple-system,"Segoe UI",sans-serif'
    var t = document.createElement('div'); t.textContent = opts.title
    t.style.cssText = 'font-size:15px;font-weight:600;margin-bottom:10px'
    var b = document.createElement('div'); b.textContent = opts.body
    b.style.cssText = 'font-size:12.5px;color:#a8a8a8;line-height:1.7;margin-bottom:14px'
    // 回退影响清单：按 类型 → 文件列表 渲染
    var fileList = document.createElement('div')
    if (opts.groups && opts.groups.length) {
      var COLORS = { del: ['#ff8a8a', '将删除'], mod: ['#ffd479', '将恢复改动'], res: ['#7ce38b', '将恢复文件'] }
      opts.groups.forEach(function(g){
        var head = document.createElement('div')
        var c = COLORS[g.kind] || ['#cfcfcf', g.kind]
        head.style.cssText = 'font-size:12px;font-weight:600;color:' + c[0] + ';margin:10px 0 4px'
        head.textContent = c[1] + '（' + g.paths.length + '）'
        fileList.appendChild(head)
        var MAX = 5
        g.paths.slice(0, MAX).forEach(function(p){
          var item = document.createElement('div')
          item.style.cssText = 'font-size:11.5px;color:#bdbdbd;font-family:ui-monospace,Consolas,monospace;padding:1px 0 1px 12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          item.textContent = p
          item.title = p
          fileList.appendChild(item)
        })
        if (g.paths.length > MAX) {
          var more = document.createElement('div')
          more.style.cssText = 'font-size:11px;color:#8a8a8a;padding:1px 0 1px 12px'
          more.textContent = '… 等共 ' + g.paths.length + ' 个文件'
          fileList.appendChild(more)
        }
      })
      fileList.style.cssText = 'margin-bottom:14px;border:1px solid rgba(255,255,255,.08);border-radius:8px;padding:4px 12px 10px;background:rgba(255,255,255,.03)'
    }
    var row = document.createElement('div'); row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end'
    function mk(text, primary){
      var x = document.createElement('button'); x.type = 'button'; x.textContent = text
      x.style.cssText = primary
        ? 'padding:7px 16px;border-radius:8px;border:none;background:#4c6ef5;color:#fff;font-size:13px;cursor:pointer'
        : 'padding:7px 16px;border-radius:8px;border:1px solid rgba(255,255,255,.16);background:transparent;color:#cfcfcf;font-size:13px;cursor:pointer'
      return x
    }
    var cancel = mk(opts.cancelText || '取消', false)
    var ok = mk(opts.okText || '确认', true)
    ok.setAttribute('data-dsh-rw-modal-ok', '1')
    function close(){ overlay.remove() }
    cancel.onclick = function(){ close(); opts.onCancel && opts.onCancel() }
    ok.onclick = function(){ close(); opts.onOk && opts.onOk() }
    overlay.onclick = function(e){ if (e.target === overlay) { close(); opts.onCancel && opts.onCancel() } }
    row.appendChild(cancel); row.appendChild(ok)
    card.appendChild(t); card.appendChild(b)
    if (opts.groups && opts.groups.length) card.appendChild(fileList)
    card.appendChild(row)
    overlay.appendChild(card); document.body.appendChild(overlay)
    ok.focus()
  }
  /** 计算回退到 turn 之前的影响清单（与后端 planCodeRestore 同语义：同路径取最早快照） */
  function impactGroups(turn){
    var byPath = {}
    var cps = state.checkpoints || []
    for (var i = 0; i < cps.length; i++) {
      var cp = cps[i]
      if (cp.turn < turn) continue
      var files = cp.files || []
      for (var fi = 0; fi < files.length; fi++) {
        var f = files[fi]
        if (!byPath[f.path] || cp.turn < byPath[f.path].turn) byPath[f.path] = { turn: cp.turn, kind: f.kind }
      }
    }
    var groups = { del: [], mod: [], res: [] }
    Object.keys(byPath).forEach(function(p){
      var k = byPath[p].kind
      if (k === 'create') groups.del.push(p)
      else if (k === 'modify') groups.mod.push(p)
      else if (k === 'delete') groups.res.push(p)
    })
    var out = []
    if (groups.del.length) out.push({ kind: 'del', paths: groups.del.sort() })
    if (groups.mod.length) out.push({ kind: 'mod', paths: groups.mod.sort() })
    if (groups.res.length) out.push({ kind: 'res', paths: groups.res.sort() })
    return out
  }
  function toast(msg){
    var old = document.getElementById('dsh-rw-toast')
    if (old) old.remove()
    var el = document.createElement('div')
    el.id = 'dsh-rw-toast'
    el.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2147483647;background:#2a2a2e;color:#eee;border:1px solid rgba(255,255,255,.12);border-radius:10px;padding:12px 16px;font-size:13px;max-width:380px;box-shadow:0 8px 28px rgba(0,0,0,.5)'
    el.textContent = msg
    document.body.appendChild(el)
    setTimeout(function(){ el.remove() }, 6000)
  }
  function rowKey(row){
    var clone = row.cloneNode(true)
    var mine = clone.querySelector('[data-dsh-rw-btn]')
    if (mine) mine.remove()
    return norm(clone.innerText || '')
  }
  function pairRows(){
    var rows = [...document.querySelectorAll('div.cJsG2q_userRow')]
    var consumed = new Set()
    var pairs = []
    for (var ri = 0; ri < rows.length; ri++) {
      var fi = rows[ri].closest('div.xz4KEq_flowItem')
      if (fi && (fi.style.display === 'none' || fi.hasAttribute('data-dsh-rw-hidden'))) continue
      var key = rowKey(rows[ri])
      if (!key) continue
      var hit = -1
      for (var mi = 0; mi < state.messages.length; mi++) {
        if (consumed.has(mi)) continue
        var full = norm(state.messages[mi].promptFull)
        if (!full) continue
        if (full === key || full.indexOf(key) !== -1 || key.indexOf(full) !== -1) { hit = mi; break }
      }
      if (hit >= 0) { consumed.add(hit); pairs.push({ row: rows[ri], msg: state.messages[hit] }) }
    }
    return pairs
  }
  function backfill(text){
    var el = document.querySelector('[contenteditable="true"]')
    if (!el || !text) return false
    el.focus()
    document.execCommand('selectAll', false, null)
    document.execCommand('delete', false, null)
    document.execCommand('insertText', false, text)
    return true
  }
  function collapseFrom(flowItem){
    // Trae 式视觉回退：隐藏该消息块及其后的全部转写块（会话切换时还原）
    var node = flowItem
    while (node) {
      if (node.classList && node.classList.contains('xz4KEq_flowItem')) {
        node.setAttribute('data-dsh-rw-hidden', '1')
        node.style.display = 'none'
      }
      node = node.nextElementSibling
    }
  }
  function onBtnClick(msg, btn){
    var turn = msg.turn
    var run = function(){
      btn.disabled = true; btn.__dshRwBusy = true; btn.textContent = '回退中…'
      fetch('/dsh-rewind/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ turn: turn, scope: 'both' }) })
      .then(function(r){ return r.json() })
      .then(function(d){
        if (d && d.ok) {
          backfill(msg.promptFull)
          var fi = btn.closest('div.xz4KEq_flowItem')
          var rwRow = btn.closest('div.cJsG2q_userRow')
          if (fi) collapseFrom(fi)
          // 记录该会话的折叠点：切换会话后回来仍保持已折叠
          try { localStorage.setItem(cutStorageKey(), JSON.stringify({ turn: turn, key: rwRow ? rowKey(rwRow) : '' })) } catch { }
          btn.textContent = '已回退'
          fetchState(true)
          setTimeout(function(){ btn.__dshRwBusy = false; btn.innerHTML = RW_ICON; btn.disabled = false }, 4000)
        } else {
          btn.__dshRwBusy = false; btn.innerHTML = RW_ICON; btn.disabled = false
          toast('回退失败：' + ((d && d.error) || '未知错误'))
        }
      })
      .catch(function(e){ btn.__dshRwBusy = false; btn.innerHTML = RW_ICON; btn.disabled = false; toast('请求失败：' + e) })
    }
    if (!CONFIRM) return run()
    var groups = impactGroups(turn)
    openModal({
      title: '回退到这条消息之前？',
      body: groups.length
        ? '该消息之后的文件改动与对话将被一起回退，输入框会回填这条消息原文供你修改重发。影响范围：'
        : '该消息之后没有文件改动，仅回退对话；输入框会回填这条消息原文供你修改重发。',
      groups: groups,
      okText: '确认回退',
      onOk: run,
    })
  }
  /** 持久化折叠：会话切换/重载后，被回退的消息块继续保持隐藏（新轮次不受影响） */
  function applyStoredCut(pairs){
    var raw = null
    try { raw = localStorage.getItem(cutStorageKey()) } catch { return }
    if (!raw) return
    var cut
    try { cut = JSON.parse(raw) } catch { return }
    if (!cut || !cut.key) return
    var pairedRows = new Set(pairs.map(function(p){ return p.row }))
    var rows = [...document.querySelectorAll('div.cJsG2q_userRow')]
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i]
      if (pairedRows.has(row)) continue
      var fi = row.closest('div.xz4KEq_flowItem')
      if (!fi || fi.hasAttribute('data-dsh-rw-hidden') || fi.style.display === 'none') continue
      if (rowKey(row) !== cut.key) continue
      // 找折叠终点：其后第一个"配对了新轮"的块（新回合内容必须保持可见）
      var stop = null
      var node = fi.nextElementSibling
      while (node) {
        if (node.classList && node.classList.contains('xz4KEq_flowItem')) {
          var r2 = node.querySelector('div.cJsG2q_userRow')
          if (r2 && pairedRows.has(r2)) { stop = node; break }
        }
        node = node.nextElementSibling
      }
      node = fi
      while (node && node !== stop) {
        var nxt = node.nextElementSibling
        if (node.classList && node.classList.contains('xz4KEq_flowItem')) {
          var r3 = node.querySelector('div.cJsG2q_userRow')
          if (!(r3 && pairedRows.has(r3))) {
            node.setAttribute('data-dsh-rw-hidden', '1')
            node.style.display = 'none'
          }
        }
        node = nxt
      }
      break
    }
  }
  function render(){
    var pairs = pairRows()
    var paired = new Set()
    pairs.forEach(function(p){
      paired.add(p.row)
      var actions = p.row.querySelector('div.xD_KDq_actions')
      if (!actions) return
      var btn = actions.querySelector('[data-dsh-rw-btn]')
      if (!btn) {
        btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'xD_KDq_action'
        btn.setAttribute('data-dsh-rw-btn', '1')
        btn.setAttribute('aria-label', '回退到这条消息之前')
        btn.title = '回退到这条消息之前（文件与对话一起退回）'
        actions.appendChild(btn)
      }
      btn.dataset.turn = String(p.msg.turn)
      if (!btn.__dshRwBusy && btn.innerHTML !== RW_ICON) btn.innerHTML = RW_ICON
      if (!btn.__dshRwBound) {
        btn.__dshRwBound = true
        btn.addEventListener('click', function(){
          // 以 dataset.turn 实时解析消息：DOM 节点可能被前端复用，闭包里的
          // p.msg 会过期（点 A 行回退了 B 轮的实测 bug），dataset.turn 每次 render 刷新
          var turn = Number(btn.dataset.turn)
          var msg = null
          for (var mi = 0; mi < state.messages.length; mi++) {
            if (state.messages[mi].turn === turn) { msg = state.messages[mi]; break }
          }
          onBtnClick(msg || p.msg, btn)
        })
      }
    })
    // 未配对行移除残留按钮（已折叠隐藏的行除外）
    ;[...document.querySelectorAll('[data-dsh-rw-btn]')].forEach(function(btn){
      var row = btn.closest('div.cJsG2q_userRow')
      var fi = row && row.closest('div.xz4KEq_flowItem')
      var hidden = fi && (fi.style.display === 'none' || fi.hasAttribute('data-dsh-rw-hidden'))
      if (row && !paired.has(row) && !hidden) btn.remove()
    })
    // 维持已折叠块的隐藏状态（客户端重渲染后兜底）
    ;[...document.querySelectorAll('[data-dsh-rw-hidden]')].forEach(function(el){
      if (el.style.display !== 'none') el.style.display = 'none'
    })
    // 会话切换/重载后按持久化折叠点恢复隐藏
    applyStoredCut(pairs)
  }
  function scheduleRender(){
    if (render.__t) clearTimeout(render.__t)
    // DOM 变化多为会话切换/新消息：必须强制刷新，否则 10s 缓存里的旧会话
    // messages 会让按钮配对失败（"有时不出现"的根因之一）
    render.__t = setTimeout(function(){ fetchState(true, render) }, 150)
  }
  function start(){
    // 挂在 body 上：会话切换可能整体替换转写容器，挂容器会失联
    var mo = new MutationObserver(scheduleRender)
    mo.observe(document.body, { childList: true, subtree: true })
    fetchState(true, render)
    setInterval(function(){ fetchState(true, render) }, 15000)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start)
  else start()
})();
`

/** 生成 index-inject 注入行（在 apply 内同步 push 到 table）
 *  @param {object[]} table
 *  @param {{panel?: boolean, confirm?: boolean}} [opts]
 */
export function pushInjectRows(table, opts = {}) {
  // 配置 + 消息级回退脚本（默认 UI）
  table.push({ kind: 'global', name: '__DSH_REWIND_CONFIG__', value: { confirm: opts.confirm !== false } })
  table.push({ kind: 'style', text: MSG_CSS })
  table.push({ kind: 'script', text: MESSAGE_JS, placement: 'body' })
  // 悬浮面板（可选）
  if (opts.panel) {
    table.push({ kind: 'style', text: PANEL_CSS })
    table.push({ kind: 'script', text: PANEL_JS, placement: 'body' })
  }
}

/** 读请求体为 JSON（限制 1MB） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > 1024 * 1024) { reject(new Error('body too large')); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}) }
      catch (err) { reject(err) }
    })
    req.on('error', reject)
  })
}

function sendJson(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(body)
}

/**
 * 构造 REST 路由表（在 webServer 就绪后注册）。
 * @param {import('./service.js').RewindService} service
 */
export function buildRoutes(service) {
  return [
    {
      kind: 'exact',
      path: '/dsh-rewind/api/checkpoints',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' })
        const url = new URL(req.url, 'http://local')
        const sessionId = url.searchParams.get('sessionId') || undefined
        return sendJson(res, 200, service.listCheckpoints(sessionId))
      },
    },
    {
      kind: 'exact',
      path: '/dsh-rewind/api/restore',
      handler: async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' })
        let body
        try { body = await readBody(req) } catch (err) { return sendJson(res, 400, { ok: false, error: String(err.message || err) }) }
        try {
          const result = await service.restore(body)
          return sendJson(res, result.ok ? 200 : 409, result)
        } catch (err) {
          return sendJson(res, 500, { ok: false, error: String(err?.message || err) })
        }
      },
    },
  ]
}
