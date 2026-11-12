// bad: the table sits in a cfg-disabled module
#[cfg(any())]
mod inactive {
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
    ("GET", "/api/v1/models"),
];
}
