import { createRoot } from 'react-dom/client';
import { App } from './App';
import '../shell/shell.css';
import '../tools/reading-log/src/reading.css';
import './mobile.css';

createRoot(document.getElementById('root')!).render(<App />);
