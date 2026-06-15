import messages from '@proj-airi/i18n/locales'

import { resolveSupportedLocale } from '@proj-airi/i18n'
import { createI18n } from 'vue-i18n'

function getLocale() {
  let language = localStorage.getItem('settings/language')

  if (!language) {
    // Fallback to browser language
    language = navigator.language || 'en'
  }

  return resolveSupportedLocale(language, Object.keys(messages!))
}

export const i18n = createI18n({
  legacy: false,
  locale: getLocale(),
  fallbackLocale: 'en',
  messages,
  // Several shipped locale strings intentionally contain HTML (e.g. the Ollama
  // setup notice uses <code>/<a>). vue-i18n logs a "Detected HTML in '...'"
  // warning for each such interpolation, which floods the console (the Ollama
  // notice fires on every failed provider health check). The messages are
  // first-party (not user input), so silence the warning.
  warnHtmlMessage: false,
})
