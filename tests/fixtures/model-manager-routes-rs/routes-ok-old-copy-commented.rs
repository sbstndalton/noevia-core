// valid: the old table survives only in comments; the active one dropped /api/v1/models
// const ROUTES: old copy
/* the previous table, kept for reference
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
    ("GET", "/api/v1/models"),
];
   /* nested */ */
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
