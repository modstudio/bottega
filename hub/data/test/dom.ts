import { GlobalRegistrator } from '@happy-dom/global-registrator'

// One DOM for the whole process: testing-library binds to the document that exists when it is
// first imported, so a file that re-registers happy-dom would leave the next file a stale one.
GlobalRegistrator.register({ url: 'http://localhost' })
