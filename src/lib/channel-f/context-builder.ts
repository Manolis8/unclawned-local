import { db, p } from '../db.js'

export function buildChannelFContextBlock(userId: string): string | null {
  try {
    const totalProfiles = (db.prepare(
      `SELECT COUNT(*) AS cnt FROM channel_f_relationship_profiles WHERE user_id = ?`
    ).get(userId) as any)?.cnt ?? 0

    if (totalProfiles < 3) return null

    const lines: string[] = ['## Relationship Intelligence']
    let hasSomething = false

    // Rising relationships (trajectory = 'rising')
    const rising = db.prepare(`
      SELECT person_name, mention_count FROM channel_f_relationship_profiles
      WHERE user_id = ? AND trajectory = 'rising'
      ORDER BY mention_count DESC LIMIT 3
    `).all(userId) as any[]
    if (rising.length > 0) {
      lines.push(`**Increasing activity:** ${rising.map(r => r.person_name).join(', ')} (mentioned more frequently lately)`)
      hasSomething = true
    }

    // Cooling/silent relationships
    const cooling = db.prepare(`
      SELECT person_name, trajectory FROM channel_f_relationship_profiles
      WHERE user_id = ? AND trajectory IN ('cooling', 'silent') AND mention_count >= 3
      ORDER BY mention_count DESC LIMIT 2
    `).all(userId) as any[]
    if (cooling.length > 0) {
      const names = cooling.map(r => `${r.person_name} (${r.trajectory})`).join(', ')
      lines.push(`**Fading from conversations:** ${names}`)
      hasSomething = true
    }

    // Trusted inner circle (positive-toned, appear in trusted_circle cluster)
    const trusted = db.prepare(`
      SELECT person_name FROM channel_f_relationship_profiles
      WHERE user_id = ? AND cluster_tags LIKE '%trusted_circle%'
      ORDER BY mention_count DESC LIMIT 3
    `).all(userId) as any[]
    if (trusted.length > 0) {
      lines.push(`**Trusted contacts:** ${trusted.map(r => r.person_name).join(', ')} (consistently positive context)`)
      hasSomething = true
    }

    // Bridge nodes (appear across multiple clusters)
    const bridges = db.prepare(`
      SELECT person_name FROM channel_f_relationship_profiles
      WHERE user_id = ? AND is_bridge = 1
      ORDER BY mention_count DESC LIMIT 3
    `).all(userId) as any[]
    if (bridges.length > 0) {
      lines.push(`**Bridge contacts** (connect multiple parts of your world): ${bridges.map(r => r.person_name).join(', ')}`)
      hasSomething = true
    }

    // Communication register map — only surface if non-trivial
    const registers = db.prepare(`
      SELECT person_name, communication_register FROM channel_f_relationship_profiles
      WHERE user_id = ? AND communication_register IS NOT NULL
      ORDER BY mention_count DESC LIMIT 5
    `).all(userId) as any[]
    if (registers.length > 0) {
      const regMap = registers.map(r => `${r.person_name} → ${r.communication_register}`).join(', ')
      lines.push(`**Communication style map:** ${regMap}`)
      hasSomething = true
    }

    // Fallback: list top contacts by mention count when no specific signal fired
    if (!hasSomething) {
      const topContacts = db.prepare(`
        SELECT person_name FROM channel_f_relationship_profiles
        WHERE user_id = ?
        ORDER BY mention_count DESC LIMIT 5
      `).all(userId) as any[]
      if (topContacts.length > 0) {
        lines.push(`**Contacts in conversations:** ${topContacts.map(r => r.person_name).join(', ')}`)
      } else {
        return null
      }
    }

    return lines.join('\n')
  } catch {
    return null
  }
}

// For the draft-message flow: when the agent drafts a message to a named person, look up their register
export function getPersonRegister(userId: string, personName: string): string | null {
  try {
    const row = db.prepare(
      `SELECT communication_register FROM channel_f_relationship_profiles WHERE user_id = ? AND person_name = ?`
    ).get(userId, personName) as any
    return row?.communication_register ?? null
  } catch {
    return null
  }
}
