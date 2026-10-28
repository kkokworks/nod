// The capture window: Enter runs `nod in` through the app, Esc puts the window away. As a panel
// (make_panel in main.rs) the window takes Esc itself before this page. This is left for the
// plain window it stays if it cannot be one, where Esc may not get here either: the panel did
// not pass it on as Escape, and that was not narrowed down to the input method or the page.
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
  const sent = text.value
  try {
    await invoke('capture', { text: sent })
    // What was typed while it was sent stays, to send next.
    if (text.value.startsWith(sent)) text.value = text.value.slice(sent.length)
    error.textContent = ''
  } catch (e) {
    // Kept as typed, to send again once whatever went wrong is fixed.
    error.textContent = String(e)
  } finally {
    sending = false
  }
})
