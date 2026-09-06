export function createInFlightGate() {
  let inFlight = false

  return {
    enter() {
      if (inFlight) return false
      inFlight = true
      return true
    },
    leave() {
      inFlight = false
    },
  }
}
