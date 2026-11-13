/** Self-contained configuration console; no build step and no external assets. */
export const PAGE_HTML = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Forge 配置中心</title>
<style>
  :root { color-scheme: light dark; --bg:#f7f7f8; --fg:#1a1a1c; --muted:#6b6b70; --line:#e3e3e6; --card:#fff; --accent:#4d6bfe; --danger:#c0392b; }
  @media (prefers-color-scheme: dark) { :root { --bg:#17171a; --fg:#ececef; --muted:#9a9aa2; --line:#2c2c31; --card:#1f1f24; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif; }
  header { padding:20px 28px 0; }
  h1 { font-size:18px; margin:0 0 4px; }
  .sub { color:var(--muted); font-size:12px; }
  nav { display:flex; gap:4px; padding:16px 28px 0; border-bottom:1px solid var(--line); }
  nav button { border:0; background:none; padding:10px 14px; font:inherit; color:var(--muted); cursor:pointer; border-bottom:2px solid transparent; }
  nav button[aria-selected="true"] { color:var(--fg); border-bottom-color:var(--accent); }
  main { padding:20px 28px 48px; max-width:1080px; }
  .panel { display:none; } .panel.active { display:block; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:18px; margin-bottom:16px; }
  .row { display:flex; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
  input[type=text], input[type=number], select, textarea { width:100%; padding:8px 10px; border:1px solid var(--line); border-radius:8px; background:var(--bg); color:var(--fg); font:inherit; }
  textarea { min-height:420px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; line-height:1.5; tab-size:2; }
  .field { flex:1 1 240px; }
  button.primary { background:var(--accent); color:#fff; border:0; border-radius:8px; padding:9px 16px; font:inherit; cursor:pointer; }
  button.ghost { background:none; border:1px solid var(--line); color:var(--fg); border-radius:8px; padding:9px 14px; font:inherit; cursor:pointer; }
  .status { margin-top:10px; font-size:12.5px; white-space:pre-wrap; }
  .ok { color:#1e874b; } .err { color:var(--danger); }
  .files { display:flex; flex-wrap:wrap; gap:8px; margin:8px 0 14px; }
  .files button { border:1px solid var(--line); background:none; color:var(--fg); border-radius:999px; padding:6px 12px; font:inherit; font-size:12.5px; cursor:pointer; }
  .files button[aria-pressed="true"] { border-color:var(--accent); color:var(--accent); }
  .hint { color:var(--muted); font-size:12px; }
</style>
</head>
<body>
<header>
  <h1>Forge 配置中心</h1>
  <div class="sub">DSH 插件配置回写 · Skill Profile YAML 编辑</div>
</header>
<nav>
  <button id="tab-config" aria-selected="true">插件配置</button>
  <button id="tab-files" aria-selected="false">Skill Profile YAML</button>
</nav>
<main>
  <section id="panel-config" class="panel active">
    <div class="card">
      <div class="row">
        <div class="field"><label>DSH profile</label><select id="cfg-profile"></select></div>
        <div class="field"><label>配置文件</label><input type="text" id="cfg-path" readonly></div>
      </div>
      <div class="row">
        <div class="field"><label>home（forge 数据根）</label><input type="text" id="cfg-home" placeholder="留空 = $DSH_HOME/forge"></div>
        <div class="field"><label>registry.url</label><input type="text" id="cfg-registry"></div>
      </div>
      <div class="row">
        <div class="field"><label>runtime.dora</label><input type="text" id="cfg-dora" placeholder="留空 = dora（PATH）"></div>
        <div class="field"><label>runtime.startTimeoutMs</label><input type="number" id="cfg-startTimeout" min="0" step="1000"></div>
        <div class="field"><label>gateway.callTimeoutMs</label><input type="number" id="cfg-callTimeout" min="0" step="1000"></div>
      </div>
      <div class="row">
        <div class="field"><label>skills.roots（逗号分隔，留空 = &lt;home&gt;/skills）</label><input type="text" id="cfg-roots"></div>
        <div class="field"><label>skills.watch</label><select id="cfg-watch"><option value="true">true</option><option value="false">false</option></select></div>
        <div class="field"><label>ui.port（重启后生效）</label><input type="number" id="cfg-uiPort" min="1024" max="65535"></div>
      </div>
      <button class="primary" id="cfg-save">保存并回写</button>
      <button class="ghost" id="cfg-reload">重新读取</button>
      <div class="status" id="cfg-status"></div>
    </div>
  </section>

  <section id="panel-files" class="panel">
    <div class="card">
      <div class="row">
        <div class="field"><label>Skill</label><select id="file-skill"></select></div>
        <div class="field"><label>profile</label><select id="file-profile"></select></div>
      </div>
      <div class="files" id="file-list"></div>
      <textarea id="file-editor" spellcheck="false"></textarea>
      <div class="row" style="margin-top:12px">
        <button class="primary" id="file-save">保存</button>
        <button class="ghost" id="file-reload">重新读取</button>
        <span class="hint" id="file-meta"></span>
      </div>
      <div class="status" id="file-status"></div>
    </div>
  </section>
</main>
<script>
(function () {
  var state = { profile: null, skill: null, skillProfile: null, file: null };
  function $(id) { return document.getElementById(id); }
  function status(el, text, ok) { el.className = 'status ' + (ok ? 'ok' : 'err'); el.textContent = text; }
  function get(url) { return fetch(url).then(function (r) { return r.json(); }); }
  function send(method, url, body) {
    return fetch(url, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json(); });
  }
  function options(select, values, selected) {
    select.innerHTML = '';
    values.forEach(function (value) {
      var option = document.createElement('option');
      option.value = value; option.textContent = value;
      if (value === selected) option.selected = true;
      select.appendChild(option);
    });
  }

  // tabs
  function tab(name) {
    var config = name === 'config';
    $('tab-config').setAttribute('aria-selected', String(config));
    $('tab-files').setAttribute('aria-selected', String(!config));
    $('panel-config').classList.toggle('active', config);
    $('panel-files').classList.toggle('active', !config);
  }
  $('tab-config').onclick = function () { tab('config'); };
  $('tab-files').onclick = function () { tab('files'); };

  // plugin config
  function fillConfig(data) {
    var c = data.config || {};
    $('cfg-path').value = data.path || '';
    $('cfg-home').value = c.home || '';
    $('cfg-registry').value = (c.registry && c.registry.url) || '';
    $('cfg-dora').value = (c.runtime && c.runtime.dora) || '';
    $('cfg-startTimeout').value = (c.runtime && c.runtime.startTimeoutMs) || 120000;
    $('cfg-callTimeout').value = (c.gateway && c.gateway.callTimeoutMs) || 15000;
    $('cfg-roots').value = (c.skills && c.skills.roots) ? c.skills.roots.join(', ') : '';
    $('cfg-watch').value = !(c.skills && c.skills.watch === false) ? 'true' : 'false';
    $('cfg-uiPort').value = (c.ui && c.ui.port) || 19080;
    status($('cfg-status'), data.rowExists ? '已读取现有配置行' : '配置行尚不存在，保存时会插入', true);
  }
  function loadConfig() {
    get('/api/config?profile=' + encodeURIComponent($('cfg-profile').value)).then(fillConfig).catch(function (e) {
      status($('cfg-status'), String(e), false);
    });
  }
  function saveConfig() {
    var config = {
      home: $('cfg-home').value,
      registry: { url: $('cfg-registry').value },
      runtime: { dora: $('cfg-dora').value, startTimeoutMs: Number($('cfg-startTimeout').value) },
      gateway: { callTimeoutMs: Number($('cfg-callTimeout').value) },
      skills: {
        roots: $('cfg-roots').value.split(',').map(function (s) { return s.trim(); }).filter(Boolean),
        watch: $('cfg-watch').value === 'true'
      },
      ui: { port: Number($('cfg-uiPort').value) }
    };
    send('PUT', '/api/config', { profile: $('cfg-profile').value, config: config }).then(function (data) {
      if (data.ok) status($('cfg-status'), '已写入 ' + data.path + (data.backup ? '\n备份: ' + data.backup : '') + '\n插件会在下次重载时应用新配置。', true);
      else status($('cfg-status'), data.error, false);
    }).catch(function (e) { status($('cfg-status'), String(e), false); });
  }
  $('cfg-save').onclick = saveConfig;
  $('cfg-reload').onclick = loadConfig;
  $('cfg-profile').onchange = loadConfig;

  get('/api/profiles').then(function (data) {
    var profiles = data.profiles || [];
    options($('cfg-profile'), profiles, data.current || profiles[0]);
    loadConfig();
  });

  // skill files
  function loadSkills() {
    get('/api/skills').then(function (data) {
      var skills = data.skills || [];
      options($('file-skill'), skills.map(function (s) { return s.name; }), state.skill || (skills[0] && skills[0].name));
      onSkillChange();
    });
  }
  function onSkillChange() {
    state.skill = $('file-skill').value;
    get('/api/skills').then(function (data) {
      var skill = (data.skills || []).find(function (s) { return s.name === state.skill; });
      var profiles = skill ? skill.profiles.map(function (p) { return p.id; }) : [];
      options($('file-profile'), profiles, state.skillProfile || profiles[0]);
      onProfileChange();
    });
  }
  function onProfileChange() {
    state.skillProfile = $('file-profile').value;
    get('/api/skills').then(function (data) {
      var skill = (data.skills || []).find(function (s) { return s.name === state.skill; });
      var profile = skill && skill.profiles.find(function (p) { return p.id === state.skillProfile; });
      var files = profile ? profile.files.map(function (f) { return f.path; }) : [];
      var list = $('file-list'); list.innerHTML = '';
      files.forEach(function (path) {
        var button = document.createElement('button');
        button.textContent = path;
        button.setAttribute('aria-pressed', String(path === state.file));
        button.onclick = function () { state.file = path; loadFile(); onProfileChange(); };
        list.appendChild(button);
      });
      if (files.length === 0) { $('file-editor').value = ''; status($('file-status'), '该 profile 没有可编辑文件', false); return; }
      if (!state.file || files.indexOf(state.file) < 0) state.file = files[0];
      loadFile();
    });
  }
  function loadFile() {
    var url = '/api/skill-file?skill=' + encodeURIComponent(state.skill) + '&profile=' + encodeURIComponent(state.skillProfile) + '&file=' + encodeURIComponent(state.file);
    get(url).then(function (data) {
      if (data.ok) {
        $('file-editor').value = data.content;
        $('file-meta').textContent = data.path;
        status($('file-status'), '已加载', true);
      } else status($('file-status'), data.error, false);
    });
  }
  function saveFile() {
    send('PUT', '/api/skill-file', { skill: state.skill, profile: state.skillProfile, file: state.file, content: $('file-editor').value })
      .then(function (data) {
        if (data.ok) status($('file-status'), '已保存 ' + data.path + '\n备份: ' + data.backup, true);
        else status($('file-status'), data.error, false);
      }).catch(function (e) { status($('file-status'), String(e), false); });
  }
  $('file-skill').onchange = onSkillChange;
  $('file-profile').onchange = onProfileChange;
  $('file-save').onclick = saveFile;
  $('file-reload').onclick = loadFile;
  loadSkills();
})();
</script>
</body>
</html>`
