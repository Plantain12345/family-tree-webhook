// api/_models.js
// Standardized data models and type definitions

// ============================================================================
// CONSTANTS
// ============================================================================

export const GENDER = {
  MALE: 'Male',
  FEMALE: 'Female',
  UNDEFINED: 'Undefined'
};

export const RELATIONSHIP_KIND = {
  PARENT: 'parent',
  CHILD: 'child',
  SPOUSE: 'spouse',
  DIVORCED: 'divorced',
  SEPARATED: 'separated'
};

// ============================================================================
// DATA TRANSFER OBJECTS (DTOs)
// ============================================================================

/**
 * Tree DTO
 * @typedef {Object} TreeDTO
 * @property {string} id - UUID string
 * @property {string} name - Tree name
 * @property {string} join_code - 6-character alphanumeric code
 * @property {string} created_at - ISO timestamp
 */

/**
 * Person Data (stored in JSONB)
 * @typedef {Object} PersonData
 * @property {string} first_name - Required
 * @property {string|null} last_name - Optional
 * @property {string} gender - 'Male', 'Female', or 'Undefined'
 * @property {string|null} birthday - Year only (YYYY format)
 * @property {string|null} deathday - Year only (YYYY format)
 */

/**
 * Person DTO
 * @typedef {Object} PersonDTO
 * @property {string} id - UUID string
 * @property {string} tree_id - UUID string
 * @property {PersonData} data - Person information
 * @property {string} created_at - ISO timestamp
 * @property {string} updated_at - ISO timestamp
 */

/**
 * Relationship DTO
 * @typedef {Object} RelationshipDTO
 * @property {string} id - UUID string
 * @property {string} tree_id - UUID string
 * @property {string} person_a_id - UUID string
 * @property {string} person_b_id - UUID string
 * @property {string} kind - One of RELATIONSHIP_KIND values
 * @property {string} created_at - ISO timestamp
 */

/**
 * Person with relationships (for family-chart library)
 * @typedef {Object} PersonWithRels
 * @property {string} id - UUID string
 * @property {PersonData} data - Person information
 * @property {Object} rels - Relationships
 * @property {string|null} rels.father - Father's UUID string
 * @property {string|null} rels.mother - Mother's UUID string
 * @property {string[]} rels.spouses - Array of spouse UUID strings
 * @property {string[]} rels.children - Array of children UUID strings
 */

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/**
 * Validate person data
 * @param {Object} data - Person data to validate
 * @returns {{valid: boolean, errors: string[]}}
 */
export function validatePersonData(data) {
  const errors = [];
  
  if (!data || typeof data !== 'object') {
    return { valid: false, errors: ['Person data must be an object'] };
  }
  
  // Required field: first_name
  if (!data.first_name || typeof data.first_name !== 'string' || !data.first_name.trim()) {
    errors.push('first_name is required and must be a non-empty string');
  }
  
  // Optional field: last_name
  if (data.last_name !== null && data.last_name !== undefined) {
    if (typeof data.last_name !== 'string') {
      errors.push('last_name must be a string or null');
    }
  }
  
  // Gender validation
  if (data.gender && !Object.values(GENDER).includes(data.gender)) {
    errors.push(`gender must be one of: ${Object.values(GENDER).join(', ')}`);
  }
  
  // Birthday validation (year only - YYYY)
  if (data.birthday && !isValidYear(data.birthday)) {
    errors.push('birthday must be a 4-digit year (YYYY)');
  }
  
  // Deathday validation (year only - YYYY)
  if (data.deathday && !isValidYear(data.deathday)) {
    errors.push('deathday must be a 4-digit year (YYYY)');
  }
  
  return { valid: errors.length === 0, errors };
}

/**
 * Validate relationship kind
 * @param {string} kind - Relationship kind
 * @returns {boolean}
 */
export function isValidRelationshipKind(kind) {
  return Object.values(RELATIONSHIP_KIND).includes(kind);
}

/**
 * Validate year string (YYYY format)
 * @param {string} year - Year string
 * @returns {boolean}
 */
export function isValidYear(year) {
  if (!year || typeof year !== 'string') return false;
  
  // Check for year (YYYY)
  if (!/^\d{4}$/.test(year)) return false;
  
  const yearNum = parseInt(year);
  return yearNum >= 1000 && yearNum <= 9999;
}

// ============================================================================
// NORMALIZATION FUNCTIONS
// ============================================================================

/**
 * Normalize person data
 * @param {Object} data - Raw person data
 * @returns {PersonData}
 */
export function normalizePersonData(data) {
  if (!data || typeof data !== 'object') {
    return {
      first_name: '',
      last_name: null,
      gender: GENDER.UNDEFINED,
      birthday: null,
      deathday: null
    };
  }
  
  return {
    first_name: String(data.first_name || '').trim(),
    last_name: data.last_name ? String(data.last_name).trim() : null,
    gender: normalizeGender(data.gender),
    birthday: normalizeYear(data.birthday),
    deathday: normalizeYear(data.deathday)
  };
}

/**
 * Normalize gender value to full word
 * @param {string|null} gender - Gender value
 * @returns {string} 'Male', 'Female', or 'Undefined'
 */
export function normalizeGender(gender) {
  if (!gender) return GENDER.UNDEFINED;
  
  const g = String(gender).toLowerCase().trim();
  
  // Handle abbreviations
  if (g === 'm' || g === 'male') return GENDER.MALE;
  if (g === 'f' || g === 'female') return GENDER.FEMALE;
  
  // Handle full words
  if (g === 'male') return GENDER.MALE;
  if (g === 'female') return GENDER.FEMALE;
  
  return GENDER.UNDEFINED;
}

/**
 * Normalize date to year (YYYY) format only
 * @param {string|null} date - Date string in various formats
 * @returns {string|null} Year in YYYY format or null
 */
export function normalizeYear(date) {
  if (!date) return null;
  
  const str = String(date).trim();
  
  // If already a 4-digit year, validate and return it
  if (/^\d{4}$/.test(str)) {
    const year = parseInt(str);
    if (year >= 1000 && year <= 9999) {
      return str;
    }
    return null;
  }
  
  // Extract year from full date (YYYY-MM-DD or similar formats)
  const fullDateMatch = str.match(/\b(19|20)\d{2}\b/);
  if (fullDateMatch) {
    return fullDateMatch[0];
  }
  
  // Extract year from slash format (MM/DD/YYYY or DD/MM/YYYY)
  const slashMatch = str.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (slashMatch) {
    return slashMatch[3];
  }
  
  // Extract from 2-digit year (convert to 4-digit)
  const twoDigitMatch = str.match(/\b(\d{2})\b/);
  if (twoDigitMatch) {
    const twoDigit = parseInt(twoDigitMatch[1]);
    // Assume 00-30 is 2000s, 31-99 is 1900s
    return twoDigit <= 30 ? `20${twoDigitMatch[1]}` : `19${twoDigitMatch[1]}`;
  }
  
  return null;
}

/**
 * Get full name from person data
 * @param {PersonData} data - Person data
 * @returns {string}
 */
export function getFullName(data) {
  if (!data) return 'Unknown';
  
  const first = data.first_name || '';
  const last = data.last_name || '';
  
  return `${first} ${last}`.trim() || 'Unknown';
}

/**
 * Generate a 6-character alphanumeric join code
 * @returns {string}
 */
export function generateJoinCode() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  return Array.from({ length: 6 })
    .map(() => chars[Math.floor(Math.random() * chars.length)])
    .join('');
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Check if value is a valid UUID (always use string UUIDs)
 * @param {any} value - Value to check
 * @returns {boolean}
 */
export function isUUID(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Check if value is a valid join code
 * @param {any} value - Value to check
 * @returns {boolean}
 */
export function isJoinCode(value) {
  if (typeof value !== 'string') return false;
  return /^[A-Z0-9]{6}$/.test(value);
}

/**
 * Convert any UUID representation to string
 * @param {any} uuid - UUID value
 * @returns {string|null}
 */
export function ensureUUIDString(uuid) {
  if (!uuid) return null;
  const str = String(uuid);
  return isUUID(str) ? str : null;
}

// ============================================================================
// DISPLAY HELPERS
// ============================================================================

/**
 * Convert gender to abbreviation for family-chart library compatibility
 * @param {string} gender - Full gender string
 * @returns {string} 'M', 'F', or 'U'
 */
export function genderToAbbreviation(gender) {
  if (gender === GENDER.MALE) return 'M';
  if (gender === GENDER.FEMALE) return 'F';
  return 'U';
}

/**
 * Convert gender abbreviation to full word
 * @param {string} abbr - Gender abbreviation
 * @returns {string} Full gender string
 */
export function abbreviationToGender(abbr) {
  if (abbr === 'M') return GENDER.MALE;
  if (abbr === 'F') return GENDER.FEMALE;
  return GENDER.UNDEFINED;
}
