import { createRecordClient, requiredRecordApiUrl } from './record-client.ts'

function publicRecordClient() {
  return createRecordClient({ baseUrl: requiredRecordApiUrl(), headers: {} })
}

export const publicDocsTree = () => publicRecordClient().publicDocs()
export const publicDoc = (id: string) => publicRecordClient().publicDoc(id)
export const publicDocSearch = (query: string) => publicRecordClient().publicDocSearch(query)
