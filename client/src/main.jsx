import React from 'react';
import { createRoot } from 'react-dom/client';
import { Capacitor } from '@capacitor/core';
import App from './App.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import { registerWorker } from './notifications.js';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-sans/700.css';
import './styles.css';
import './meeting.css';
import './calendar.css';

// MainActivity already keeps the Android WebView inside the status, cutout and navigation bars.
// Mark it so the browser/PWA safe-area spacing is not applied a second time by the web shell.
if (Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android') {
  document.documentElement.classList.add('native-android');
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

// The service worker shows notifications (Settings → Notifications).
registerWorker();
