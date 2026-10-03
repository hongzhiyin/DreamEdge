import { useRef, useState } from 'react';
import type { ProjectAction } from '../shared/contracts';
import { useModelSettings } from './useModelSettings';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { GitPanel } from './GitPanel';
import { ApplicationPanel } from './ApplicationPanel';
import { ProjectActions } from './ProjectActions';
import { AiConversation } from './AiConversation';

const tabs = ['模型连接', 'Git 历史', '应用与导出', '工程管理'] as const;
export function WorkspaceSidebar({ projectId, settingsOpen, openSettings, busy, run }: {
  projectId: string; settingsOpen: boolean; openSettings: () => void; busy: ProjectAction | null; run: (action: ProjectAction) => Promise<void>;
}) {
  const settings = useModelSettings(projectId); const [tab, setTab] = useState(0); const [commit, setCommit] = useState(false);
  const navigation = useRef<HTMLDivElement>(null);
  return <>
    <div className="sidebar-page chat-page" hidden={settingsOpen} inert={settingsOpen}>
      <AiConversation projectId={projectId} active={!settingsOpen} commit={commit}
        configured={!!settings.state?.hasKey && !!settings.state.model && !settings.state.warning}
        modelName={settings.state?.model} openSettings={() => { setTab(0); openSettings(); }} />
    </div>
    <section className="sidebar-page settings-page" aria-label="工程设置" hidden={!settingsOpen} inert={!settingsOpen}>
      <div ref={navigation} className="settings-tabs" role="tablist" aria-label="设置分类" onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (tab + 1) % tabs.length : event.key === 'ArrowLeft' ? (tab + tabs.length - 1) % tabs.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); setTab(next); (navigation.current?.children[next] as HTMLElement)?.focus();
      }}>
        {tabs.map((name, index) => <button key={name} id={`settings-tab-${index}`} role="tab" aria-selected={tab === index}
          aria-controls={`settings-panel-${index}`} tabIndex={tab === index ? 0 : -1} onClick={() => setTab(index)}>{name}</button>)}
      </div>
      <div className="settings-content">
        <div role="tabpanel" id="settings-panel-0" aria-labelledby="settings-tab-0" hidden={tab !== 0}>
          <ModelSettingsPanel settings={settings} />
        </div>
        <div role="tabpanel" id="settings-panel-1" aria-labelledby="settings-tab-1" hidden={tab !== 1}>
          <label className="ai-checkbox commit-setting"><input type="checkbox" checked={commit} onChange={event => setCommit(event.target.checked)} />本轮完成后提交工程修改到 Git</label>
          <p className="ai-hint">开启后发送的修改将自动应用并提交 Git；默认保留为工作区修改。</p>
          <GitPanel projectId={projectId} />
        </div>
        <div role="tabpanel" id="settings-panel-2" aria-labelledby="settings-tab-2" hidden={tab !== 2}>
          <ApplicationPanel projectId={projectId} />
        </div>
        <div role="tabpanel" id="settings-panel-3" aria-labelledby="settings-tab-3" hidden={tab !== 3}>
          <h2>工程管理</h2><p className="ai-hint">每个工程拥有独立的源码、模型连接和 Git 历史。</p>
          <ProjectActions busy={busy} run={run} />
        </div>
      </div>
    </section>
  </>;
}
