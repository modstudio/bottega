export function idlePortDeps() {
  const unused = async () => {
    throw new Error('hosted port catalogue is unused in this fixture')
  }
  return { listPortCatalogue: async () => [], writePort: unused }
}

export function idleCredentialDeps() {
  const unused = async () => {
    throw new Error('hosted credential preferences are unused in this fixture')
  }
  return {
    listCredentialPreferences: async () => [],
    putCredentialPreference: unused,
    deleteCredentialPreference: async () => undefined,
  }
}
