import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import './theme.css';
import './layout.css';
import './composer.css';
import './messages.css';
import './tools.css';
import './files.css';
import './mcp.css';
import './responsive.css';

createRoot(document.getElementById('root')!).render(window.dreamedge ? <App />
  : <div className="loading-state" role="alert">无法连接聊天服务，请重新启动 DreamEdge。</div>);
