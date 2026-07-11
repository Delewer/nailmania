import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import './components.css'
import './pages.css'

const BUILD_HEALTH_MARK = 'asset-cache-guard-v2';

function ReadyMarker(){
  React.useEffect(()=>{
    window.__NM_BUILD_HEALTH__ = BUILD_HEALTH_MARK;
    if(typeof window.__NM_MARK_READY__ === 'function'){
      window.__NM_MARK_READY__();
    }else{
      window.__NM_APP_READY__ = true;
    }
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ReadyMarker/>
    <App/>
  </React.StrictMode>
)
