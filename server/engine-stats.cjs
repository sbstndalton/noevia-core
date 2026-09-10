// Upstream statistics are samples, not independently measured benchmarks. A
// token rate over a tiny interval can be dominated by timer precision or caching.
function reportedTokenRate(generation) {
  const rate=generation?.tokens_per_second, count=generation?.output_tokens;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isSafeInteger(count) || count < 2) return null;
  // Infer the sample window from the reported count/rate. Require at least one
  // second rather than displaying a tiny-sample spike as sustained throughput.
  if (count / rate < 1) return null;
  return rate;
}
module.exports={reportedTokenRate};
