function safe_stringify(message: string, default_meta: any, data: any) {
  try {
    return JSON.stringify(Object.assign({ message }, default_meta, { data: data }))
  } catch (e) {
    return JSON.stringify(Object.assign({ message }, default_meta, { data: data.toString() }))
  }
}

export class Logger {
  default_meta: any

  constructor(default_meta: any) {
    this.default_meta = default_meta
  }

  // NB: we use JSON.stringify as the handler wrapping console in lambdas
  //     will just print [Object]

  public info(message: any, data: any = {}) {
    console.info(safe_stringify(message, this.default_meta, data))
  }

  public error(message: any, data: any = {}) {
    console.error(safe_stringify(message, this.default_meta, data))
  }

  public warn(message: any, data: any = {}) {
    console.warn(safe_stringify(message, this.default_meta, data))
  }
}
