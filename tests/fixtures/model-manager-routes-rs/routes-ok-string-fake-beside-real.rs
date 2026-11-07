// valid: a string quoting a fake table does not count, the real one does
const NOTE: &str = "const ROUTES: &[(&str, &str)] = &[(\"GET\", \"/api/v1/fake\"),];";
const RAW: &str = r#"const ROUTES: &[(&str, &str)] = &[("GET", "/api/v1/fake2"),];"#;
const ROUTES: &[(&str, &str)] = &[
    ("GET", "/api/v1/overview"),
];
