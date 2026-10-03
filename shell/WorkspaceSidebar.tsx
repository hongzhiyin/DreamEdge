import { useRef, useState } from 'react';
import type { ProjectAction } from '../shared/contracts';
import { useModelSettings } from './useModelSettings';
import { ModelSettingsPanel } from './ModelSettingsPanel';
import { GitPanel } from './GitPanel';
import { ApplicationPanel } from './ApplicationPanel';
import { ProjectActions } from './ProjectActions';
import { AiConversation } from './AiConversation';
import { useProjectGit } from './useProjectGit';
import { ProjectNamePanel } from './ProjectNamePanel';

const tabs = ['模型连接', 'Git 历史', '应用与导出', '工程管理'] as const;
export function WorkspaceSidebar({ projectId, settingsOpen, openSettings, busy, run, directory }: {
  directory: string; projectId: string; settingsOpen: boolean; openSettings: () => void; busy: ProjectAction | null; run: (action: ProjectAction) => Promise<void>;
}) {
  const settings = useModelSettings(projectId); const [tab, setTab] = useState(0); const git = useProjectGit(projectId);
  const [running, setRunning] = useState(false);
  const navigation = useRef<HTMLDivElement>(null);
  return <>
    <div className="sidebar-page chat-page" hidden={settingsOpen} inert={settingsOpen}>
      <AiConversation projectId={projectId} active={!settingsOpen} git={git} onRunning={setRunning}
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
          <GitPanel git={git} locked={running} />
        </div>
        <div role="tabpanel" id="settings-panel-2" aria-labelledby="settings-tab-2" hidden={tab !== 2}>
          <ApplicationPanel projectId={projectId} />
        </div>
        <div role="tabpanel" id="settings-panel-3" aria-labelledby="settings-tab-3" hidden={tab !== 3}>
          <h2>工程管理</h2><p className="ai-hint">每个工程拥有独立的源码、模型连接和 Git 历史。</p>
          <ProjectNamePanel projectId={projectId} locked={running || !!git.busy || busy !== null} />
          <p className="ai-hint" style={{ overflowWrap: 'anywhere' }}>{directory}</p>
          <button className="ai-button" disabled={busy !== null} onClick={() => { void run('revealProject'); }}>在 Finder 中查看工程</button>
          <ProjectActions busy={busy} run={run} />
        </div>
      </div>
    </section>
  </>;
}
