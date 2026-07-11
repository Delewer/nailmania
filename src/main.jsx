import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './styles.css'
import './components.css'
import './pages.css'

function ReadyMarker(){
  React.useEffect(()=>{
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
