// bad: cfg-disabled old table, cfg-enabled new one
#[cfg(any())]
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
    ("GET", "/api/v1/models"),
];
#[cfg(not(any()))]
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
