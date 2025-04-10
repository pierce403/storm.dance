// Import buffer and other polyfills before anything else
import './buffer-setup.js';
import setupPolyfills from './polyfills';

// Initialize polyfills immediately
setupPolyfills();

// Ensure process is defined globally
if (typeof window !== 'undefined') {
  if (!window.process) {
    window.process = { env: {} };
  }
  if (!window.process.env) {
    window.process.env = {};
  }
  
  // Force explicit Buffer global definition
  if (typeof window.Buffer === 'undefined' || typeof window.Buffer.from !== 'function') {
    console.warn("Buffer not properly defined, importing directly");
    import('buffer').then(({ Buffer }) => {
      window.Buffer = Buffer;
      console.log("Buffer loaded dynamically");
    });
  }
}

// React imports only after polyfills
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
