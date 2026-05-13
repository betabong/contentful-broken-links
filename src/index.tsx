import '@contentful/f36-tokens/dist/css/index.css';
import { GlobalStyles } from '@contentful/f36-components';
import { SDKProvider } from '@contentful/react-apps-toolkit';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <SDKProvider>
      <GlobalStyles />
      <App />
    </SDKProvider>
  </StrictMode>,
);
