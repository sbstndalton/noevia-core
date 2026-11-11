// bad: file-level inner cfg
#![cfg(any())]
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
