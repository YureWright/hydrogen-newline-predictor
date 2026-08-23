import React from 'react'
import ReactDOM from 'react-dom/client'
import 'leaflet/dist/leaflet.css'
import './styles.css'
import App from './App'
import DocsViewer from './components/DocsViewer'

// 文档库独立窗口：/?view=docs 时渲染阅读器，其余主应用
const _view = new URLSearchParams(window.location.search).get('view')
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>{_view === 'docs' ? <DocsViewer /> : <App />}</React.StrictMode>,
)
