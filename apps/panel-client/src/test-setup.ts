import '@testing-library/jest-dom'
import './i18n'
import { configure } from '@testing-library/react'

// waitFor() defaults to 1s, which is too short for the real async work in
// this suite on a busy runner. Match the suite timeout while still failing
// when the target never appears.
configure({ asyncUtilTimeout: 60000 })
