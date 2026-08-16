import { render } from 'preact'
import { registerSW } from 'virtual:pwa-register'

import './styles.css'
import { App } from './app'

// autoUpdate: a new build takes effect on the next load rather than prompting.
// A departure board should never ask the rider to make a decision about itself.
registerSW({ immediate: true })

render(<App />, document.getElementById('app')!)
