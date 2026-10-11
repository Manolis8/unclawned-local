export interface FrictionEntry {
  name: string
  trigger: string
  resolution: string
  skipOnFailure: boolean
}

export const FRICTION_REGISTRY: FrictionEntry[] = [
  {
    name: 'eu_cookie_banner',
    trigger: "perceive_page returns cookie_banner",
    resolution: "browser_dismiss_cookie — prefer Refuse/Reject over Accept All",
    skipOnFailure: true,
  },
  {
    name: 'google_consent_gate',
    trigger: "URL contains accounts.google.com/consent or consent.google.com",
    resolution: "click_element 'I agree' or 'Accept all' button",
    skipOnFailure: false,
  },
  {
    name: 'captcha_block',
    trigger: "perceive_page returns captcha",
    resolution: "exitSkill with errorCode CAPTCHA_REQUIRED",
    skipOnFailure: false,
  },
  {
    name: 'soft_paywall',
    trigger: "perceive_page returns paywall",
    resolution: "go_back_to_results and try the next search result",
    skipOnFailure: false,
  },
  {
    name: 'login_wall',
    trigger: "perceive_page returns login on a step that does not expect it",
    resolution: "exitSkill with errorCode LOGIN_REQUIRED",
    skipOnFailure: false,
  },
  {
    name: 'newsletter_popup',
    trigger: "a modal with an email input appears over the page content",
    resolution: "click_element close button (X, No thanks, Dismiss)",
    skipOnFailure: true,
  },
  {
    name: 'rate_limit_page',
    trigger: "URL contains /sorry/ or page shows 'unusual traffic' or HTTP 429",
    resolution: "wait 10 seconds then retry the step once",
    skipOnFailure: false,
  },
  {
    name: 'twitter_login_wall',
    trigger: "site is x.com and a login prompt blocks content",
    resolution: "exitSkill with errorCode TWITTER_LOGIN_REQUIRED",
    skipOnFailure: false,
  },
  {
    name: 'age_verification_gate',
    trigger: "an age confirmation modal appears before content",
    resolution: "click_element age confirmation button (e.g. 'I am 18 or older', 'Enter')",
    skipOnFailure: false,
  },
]

export const FRICTION_NAMES = FRICTION_REGISTRY.map(e => e.name)

export function frictionRegistryForPrompt(): string {
  return FRICTION_REGISTRY
    .map(e => `  ${e.name}: ${e.trigger} → ${e.resolution}${e.skipOnFailure ? ' [skip if unresolvable]' : ' [required to continue]'}`)
    .join('\n')
}

export function frictionEntryByName(name: string): FrictionEntry | undefined {
  return FRICTION_REGISTRY.find(e => e.name === name)
}
