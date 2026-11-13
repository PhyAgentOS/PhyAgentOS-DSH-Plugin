/**
 * Forge configuration page (browser half).
 *
 * Registers one card on the DSH Plugins page. Styling follows the DSH client
 * conventions: `--dsw-*` semantic tokens, primitives for controls, no color
 * literals, and one heading hierarchy. Data comes from the same-origin
 * `/forge/api` routes the Host plugin mounts on `webServer`.
 */
import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useState } from 'react'

export const inject = ['slots']

export function apply(ctx: any): void {
  ctx.effect(() => {
    const style = document.createElement('style')
    style.dataset['forgePanel'] = ''
    style.textContent = STYLES
    document.head.append(style)
    return () => style.remove()
  }, 'forge-skill: panel styles')
  ctx.effect(() => ctx.slots.inject('plugins.item', () => ctx.slots.register({
    name: 'plugins.item',
    id: 'forge-config',
    order: 20,
    label: () => 'Forge',
  }, ForgePanel)), 'forge-skill: panel')
}

const STYLES = `
.forge-panel { display:flex; flex-direction:column; gap:16px; padding:16px; box-sizing:border-box; }
.forge-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; flex-wrap:wrap; }
.forge-title { margin:0; font-size:15px; font-weight:500; line-height:22px; color:var(--dsw-alias-label-primary); }
.forge-sub { margin:2px 0 0; font-size:13px; line-height:18px; color:var(--dsw-alias-label-tertiary); }
.forge-seg { display:inline-flex; padding:2px; gap:2px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); }
.forge-seg button { border:0; background:none; color:var(--dsw-alias-label-secondary); font:inherit; font-size:13px; line-height:20px; padding:4px 12px; border-radius:8px; cursor:pointer; }
.forge-seg button[aria-pressed='true'] { background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); box-shadow:0 0 0 0.5px var(--dsw-alias-border-l1); }
.forge-section { border:0.5px solid var(--dsw-alias-border-l1); border-radius:16px; padding:14px 16px; background:var(--dsw-alias-bg-layer-1); }
.forge-section h4 { margin:0 0 10px; font-size:13px; font-weight:500; line-height:18px; color:var(--dsw-alias-label-secondary); }
.forge-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(240px, 1fr)); gap:12px 16px; }
.forge-field { display:flex; flex-direction:column; gap:4px; min-width:0; }
.forge-label { font-size:12px; line-height:16px; color:var(--dsw-alias-label-secondary); }
.forge-hint { font-size:12px; line-height:16px; color:var(--dsw-alias-label-tertiary); }
.forge-inline { display:flex; align-items:center; gap:8px; min-height:32px; }
.forge-select, .forge-textarea { width:100%; box-sizing:border-box; font:inherit; font-size:13px; line-height:20px; color:var(--dsw-alias-label-primary); background:transparent; border:0.5px solid var(--dsw-alias-border-l1); border-radius:10px; padding:6px 10px; }
.forge-select { min-height:32px; }
.forge-textarea { min-height:260px; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:12.5px; line-height:18px; resize:vertical; }
.forge-textarea:focus, .forge-select:focus { outline:2px solid var(--dsw-alias-brand-primary); outline-offset:1px; }
.forge-actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
.forge-status { display:flex; gap:8px; align-items:flex-start; font-size:12px; line-height:18px; color:var(--dsw-alias-label-secondary); white-space:pre-wrap; }
.forge-status[data-tone='error'] { color:var(--dsw-alias-state-error-primary); }
.forge-preview { min-height:240px; max-height:460px; }
.forge-pre { margin:0; padding:10px 12px; border-radius:10px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-secondary); font-size:12px; line-height:18px; overflow:auto; max-height:180px; white-space:pre-wrap; }
.forge-chips { display:flex; gap:8px; flex-wrap:wrap; }
@media (max-width:520px) { .forge-grid { grid-template-columns:1fr; } }
`

function api(path: string, init?: RequestInit): Promise<any> {
  return fetch(`/forge/api${path}`, { ...init, headers: { accept: 'application/json', ...(init?.body ? { 'content-type': 'application/json' } : {}) } }).then(response => response.json())
}

export function ForgePanel(): React.ReactElement {
  const [view, setView] = useState<'config' | 'files'>('config')
  return (
    <section className="forge-panel">
      <header className="forge-head">
        <div>
          <h3 className="forge-title">Forge</h3>
          <p className="forge-sub">审阅配置、回滚备份、查看 skill profile 文件</p>
        </div>
        <div className="forge-seg" role="group" aria-label="Forge 视图">
          <button type="button" aria-pressed={view === 'config'} onClick={() => setView('config')}>插件配置</button>
          <button type="button" aria-pressed={view === 'files'} onClick={() => setView('files')}>Skill Profile</button>
        </div>
      </header>
      {view === 'config' ? <ConfigView /> : <FileView />}
    </section>
  )
}

function Field(props: { label: string; hint?: string; children: React.ReactNode }): React.ReactElement {
  return (
    <div className="forge-field">
      <span className="forge-label">{props.label}</span>
      {props.children}
      {props.hint !== undefined && <span className="forge-hint">{props.hint}</span>}
    </div>
  )
}

function Status(props: { text: string; tone: 'ok' | 'error' }): React.ReactElement | null {
  if (props.text.length === 0) return null
  return <div className="forge-status" data-tone={props.tone} role="status">{props.text}</div>
}

function ConfigView(): React.ReactElement {
  const [profiles, setProfiles] = useState<string[]>([])
  const [profile, setProfile] = useState('')
  const [config, setConfig] = useState<any>({})
  const [backups, setBackups] = useState<any[]>([])
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'ok' | 'error'>('ok')

  const report = (text: string, ok: boolean): void => { setTone(ok ? 'ok' : 'error'); setMessage(text) }

  useEffect(() => {
    api('/profiles').then(data => {
      setProfiles(data.profiles ?? [])
      setProfile(data.current ?? (data.profiles ?? [])[0] ?? '')
    }).catch(error => report(String(error), false))
  }, [])

  const load = (name: string): void => {
    api(`/config?profile=${encodeURIComponent(name)}`).then(data => {
      setConfig(data.config ?? {})
      setBackups([])
      report(data.rowExists ? '已读取现有配置行' : '该 profile 还没有 forge 配置行，保存时会插入', true)
    }).catch(error => report(String(error), false))
  }
  useEffect(() => { if (profile !== '') load(profile) }, [profile])

  const set = (path: string, value: unknown): void => {
    setConfig((current: any) => {
      const next = { ...current }
      const keys = path.split('.')
      let cursor = next
      for (const key of keys.slice(0, -1)) cursor = cursor[key] = { ...(cursor[key] ?? {}) }
      cursor[keys[keys.length - 1]] = value
      return next
    })
  }

  const loadBackups = (): void => {
    api(`/backups?profile=${encodeURIComponent(profile)}`).then(data => {
      if (!data.ok) { report(data.error, false); return }
      setBackups(data.backups ?? [])
      report(`共 ${(data.backups ?? []).length} 个备份`, true)
    }).catch(error => report(String(error), false))
  }

  const restore = (file: string): void => {
    api('/restore-backup', { method: 'POST', body: JSON.stringify({ profile, backup: file }) }).then(data => {
      if (!data.ok) { report(data.error, false); return }
      report(`已恢复 ${data.restored}${data.previous ? `\n当前内容已备份为 ${data.previous}` : ''}`, true)
      load(profile)
    }).catch(error => report(String(error), false))
  }

  return (
    <>
      <section className="forge-section">
        <h4>存储与连接</h4>
        <div className="forge-grid">
          <Field label="DSH profile" hint="配置写入该 profile 的 cordis.patch.yml 用户层，不改组合包。">
            <select className="forge-select" value={profile} onChange={event => setProfile(event.target.value)}>
              {profiles.map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </Field>
          <Field label="home" hint="forge 数据根：skills、runtime/nodes、state.json。留空为 $DSH_HOME/forge。">
            <Input value={config.home ?? ''} placeholder="$DSH_HOME/forge" onChange={event => set('home', event.target.value)} />
          </Field>
        </div>
      </section>

      <section className="forge-section">
        <h4>资源注册表</h4>
        <div className="forge-grid">
          <Field label="registry.url" hint="安装、搜索与节点下载的来源；留空使用平台默认地址。">
            <Input value={config.registry?.url ?? ''} placeholder="https://paos-resource-platform.dev.x-era.com" onChange={event => set('registry.url', event.target.value)} />
          </Field>
          <Field label="registry.token" hint="可选 Bearer；留空读环境变量（tokenEnv，默认 DSH_FORGE_REGISTRY_TOKEN）。">
            <Input type="password" value={config.registry?.token ?? ''} placeholder="内网镜像需要时填写" onChange={event => set('registry.token', event.target.value)} />
          </Field>
        </div>
      </section>

      <section className="forge-section">
        <h4>skill 扫描</h4>
        <div className="forge-grid">
          <Field label="skills.roots" hint="逗号分隔；按顺序取第一个同名 skill。留空为 <home>/skills。">
            <Input value={(config.skills?.roots ?? []).join(', ')} placeholder="<home>/skills" onChange={event => set('skills.roots', event.target.value.split(',').map(value => value.trim()).filter(Boolean))} />
          </Field>
          <Field label="skills.watch" hint="目录监视；安装动作本身会刷新目录，关闭可省 inotify。">
            <div className="forge-inline">
              <Switch label="监视 skill 目录" checked={config.skills?.watch !== false} onChange={() => undefined} disabled />
            </div>
          </Field>
        </div>
      </section>

      <section className="forge-section">
        <h4>运行时与网关</h4>
        <div className="forge-grid">
          <Field label="runtime.dora" hint="Dora CLI 路径；留空使用 PATH 中的 dora（建议 0.4.1）。">
            <Input value={config.runtime?.dora ?? ''} placeholder="PATH 中的 dora" onChange={event => set('runtime.dora', event.target.value)} />
          </Field>
          <Field label="runtime.dora1" hint="Forge 2 使用的 dora 1.x 路径；留空按 dora1 命令名查找。">
            <Input value={config.runtime?.dora1 ?? ''} placeholder="dora1（PATH）" readOnly />
          </Field>
          <Field label="runtime.startTimeoutMs" hint="等待 Gateway /tools 就绪的上限。">
            <Input type="number" min={0} step={1000} value={String(config.runtime?.startTimeoutMs ?? 120000)} onChange={event => set('runtime.startTimeoutMs', Number(event.target.value))} />
          </Field>
          <Field label="gateway.callTimeoutMs" hint="工具调用超时；网关会截到 20000。">
            <Input type="number" min={0} step={1000} value={String(config.gateway?.callTimeoutMs ?? 15000)} onChange={event => set('gateway.callTimeoutMs', Number(event.target.value))} />
          </Field>
        </div>
      </section>

      <p className="forge-hint">配置由 agent 通过 forge_* 工具修改；这里只做审阅与回滚。</p>
      <div className="forge-actions">
        <Button variant="outline" size="sm" onClick={loadBackups}>历史备份</Button>
      </div>
      {backups.length > 0 && (
        <div className="forge-chips">
          {backups.slice(0, 6).map(item => (
            <Button key={item.file} variant="outline" size="sm" title={item.file} onClick={() => restore(item.file)}>
              {new Date(item.at).toLocaleString()}
            </Button>
          ))}
        </div>
      )}
      <Status text={message} tone={tone} />
    </>
  )
}

function FileView(): React.ReactElement {
  const [skills, setSkills] = useState<any[]>([])
  const [skill, setSkill] = useState('')
  const [profile, setProfile] = useState('')
  const [file, setFile] = useState('')
  const [content, setContent] = useState('')
  const [message, setMessage] = useState('')
  const [tone, setTone] = useState<'ok' | 'error'>('ok')

  const report = (text: string, ok: boolean): void => { setTone(ok ? 'ok' : 'error'); setMessage(text) }

  useEffect(() => {
    api('/skills').then(data => {
      setSkills(data.skills ?? [])
      const first = (data.skills ?? [])[0]
      setSkill(first?.name ?? '')
      setProfile(first?.profiles?.[0]?.id ?? '')
    }).catch(error => report(String(error), false))
  }, [])

  const current = skills.find(item => item.name === skill)
  const files: string[] = (current?.profiles?.find((item: any) => item.id === profile)?.files ?? []).map((item: any) => item.path)

  useEffect(() => {
    if (files.length > 0 && !files.includes(file)) setFile(files[0])
  }, [skill, profile])

  useEffect(() => {
    if (skill === '' || profile === '' || file === '') return
    api(`/skill-file?skill=${encodeURIComponent(skill)}&profile=${encodeURIComponent(profile)}&file=${encodeURIComponent(file)}`).then(data => {
      if (!data.ok) { report(data.error, false); return }
      setContent(data.content)
      report(`已加载 ${data.path}`, true)
    }).catch(error => report(String(error), false))
  }, [skill, profile, file])

  return (
    <>
      <section className="forge-section">
        <h4>文件选择</h4>
        <div className="forge-grid">
          <Field label="skill">
            <select className="forge-select" value={skill} onChange={event => { setSkill(event.target.value); setProfile(skills.find(item => item.name === event.target.value)?.profiles?.[0]?.id ?? '') }}>
              {skills.map(item => <option key={item.name} value={item.name}>{item.name}</option>)}
            </select>
          </Field>
          <Field label="profile" hint="forge skill 的部署选择（如 mujoco-piper），不是 DSH profile。">
            <select className="forge-select" value={profile} onChange={event => setProfile(event.target.value)}>
              {(current?.profiles ?? []).map((item: any) => <option key={item.id} value={item.id}>{item.id}</option>)}
            </select>
          </Field>
          <Field label="文件" hint="只允许 profiles/<id>/ 下的 YAML/JSON/Markdown。">
            <select className="forge-select" value={file} onChange={event => setFile(event.target.value)}>
              {files.map(path => <option key={path} value={path}>{path}</option>)}
            </select>
          </Field>
        </div>
      </section>

      <p className="forge-hint">只读预览；修改请让 agent 调用 forge_profile_write。</p>
      <pre className="forge-pre forge-preview">{content}</pre>
      <Status text={message} tone={tone} />
    </>
  )
}
