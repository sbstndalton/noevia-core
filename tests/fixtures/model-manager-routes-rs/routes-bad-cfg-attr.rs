// bad: a cfg_attr on the table
#[cfg_attr(test, allow(dead_code))]
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
