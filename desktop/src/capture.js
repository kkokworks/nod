// The capture window: Enter runs `nod in` through the app, Esc puts the window away.
const { invoke } = window.__TAURI__.core
const text = document.getElementById('text')
const error = document.getElementById('error')
let sending = false

// The window is hidden between uses, not closed; whenever it comes back, typing goes here.
window.addEventListener('focus', () => text.focus())
text.focus()

text.addEventListener('keydown', async (event) => {
  // Enter while composing Hangul only ends the syllable. WebKit ends the composition before that
  // Enter's keydown, which then still carries keyCode 229.
  if (event.isComposing || event.keyCode === 229) return
  if (event.key === 'Escape') {
    invoke('dismiss')
    return
  }
  if (event.key !== 'Enter' || sending || text.value.trim() === '') return
  sending = true
  try {
    await invoke('capture', { text: text.value })
    text.value = ''
    error.textContent = ''
  } catch (e) {
    // Kept as typed, to send again once whatever went wrong is fixed.
    error.textContent = String(e)
  } finally {
    sending = false
  }
})
