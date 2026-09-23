export class ApiError extends Error {
  status?: number
  code?: string
  isRetryable: boolean
  isTimeout: boolean
  isNetworkError: boolean
  data?: unknown

  constructor(
    message: string,
    options?: {
      status?: number
      code?: string
      isRetryable?: boolean
      isTimeout?: boolean
      isNetworkError?: boolean
      data?: unknown
    },
  ) {
    super(message)
    this.name = 'ApiError'
    this.status = options?.status
    this.code = options?.code
    this.isRetryable = Boolean(options?.isRetryable)
    this.isTimeout = Boolean(options?.isTimeout)
    this.isNetworkError = Boolean(options?.isNetworkError)
    this.data = options?.data
  }
}
