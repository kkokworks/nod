// Shown in the main window while the UI server is down. It goes on to the page it stands for once
// the server is up: on the button, and every few seconds, since at login the app may open before
// the server does.
const { invoke } = window.__TAURI__.core
const path = new URLSearchParams(location.search).get('path') ?? '/'
const status = document.getElementById('status')

function retry() {
  invoke('retry', { path }).catch((e) => {
    status.textContent = String(e)
  })
}

document.getElementById('retry').addEventListener('click', () => {
  status.textContent = ''
  retry()
})
setInterval(retry, 3000)
