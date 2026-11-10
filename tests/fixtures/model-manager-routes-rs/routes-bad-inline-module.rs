// bad: the table sits in a plain inline module (not proven to be the compiled one)
mod inner {
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
}
