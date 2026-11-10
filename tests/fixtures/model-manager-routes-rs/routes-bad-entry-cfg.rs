// bad: an entry with its own cfg
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
    #[cfg(any())]
    ("GET", "/api/v1/models"),
];
