// bad: in a cfg module
#[cfg(test)]
mod limits {
pub const MODELS_INI_MAX_BYTES: usize = 1024 * 1024;
}
