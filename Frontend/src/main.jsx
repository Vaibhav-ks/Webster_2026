import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import AccountLayer from './account/AccountLayer.jsx';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
    <AccountLayer />
  </StrictMode>,
);
