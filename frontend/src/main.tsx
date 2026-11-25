import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { flushOfflineQueue } from './api/client';

// Offline-first: phát lại hàng đợi khi trình duyệt có mạng trở lại.
if (typeof window !== 'undefined') {
  window.addEventListener('online', () => void flushOfflineQueue());
  void flushOfflineQueue();
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
