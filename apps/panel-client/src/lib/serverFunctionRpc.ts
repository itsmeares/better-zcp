export type ServerFunctionOptions = {
  data?: unknown
  context?: unknown
}

type ServerFunction = {
  __executeServer?: (
    options: ServerFunctionOptions,
  ) => Promise<{ result?: unknown; error?: unknown }>
}

export async function invokeServerFunction<T>(
  serverFunction: unknown,
  name: string,
  options: ServerFunctionOptions,
): Promise<T> {
  const executeServer = (serverFunction as ServerFunction | undefined)
    ?.__executeServer
  if (!executeServer) {
    throw new Error(`Server function ${name} is not available`)
  }

  const outcome = await executeServer(options)
  if (outcome.error) throw outcome.error
  return outcome.result as T
}
