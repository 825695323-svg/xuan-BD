import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './fonts.css';
import './ui/admin/admin.css';
import './styles.css';

const root = document.getElementById('root');
if (!root) throw new Error('页面入口不存在。');
createRoot(root).render(<StrictMode><App /></StrictMode>);
