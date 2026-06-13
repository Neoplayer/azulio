/// mulberry32 state. Construct with [`make_rng`]; draw floats in [0, 1) with
/// [`Mulberry32::next_f64`].
#[derive(Debug, Clone)]
pub struct Mulberry32 {
    a: u32,
}

/// Create a seeded PRNG. `seed` corresponds to `seed >>> 0` in the TS version
/// (the engine threads a `u32` seed through `GameState.rng_seed`).
pub fn make_rng(seed: u32) -> Mulberry32 {
    Mulberry32 { a: seed }
}

impl Mulberry32 {
    /// Next float in [0, 1). Mirrors the TS `next()` closure exactly.
    pub fn next_f64(&mut self) -> f64 {
        // a = (a + 0x6d2b79f5) | 0   (u32 wrapping add)
        self.a = self.a.wrapping_add(0x6d2b_79f5);
        let a = self.a;
        // t = Math.imul(a ^ (a >>> 15), 1 | a)
        let mut t = (a ^ (a >> 15)).wrapping_mul(1 | a);
        // t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
        t = t.wrapping_add((t ^ (t >> 7)).wrapping_mul(61 | t)) ^ t;
        // return ((t ^ (t >>> 14)) >>> 0) / 4294967296
        ((t ^ (t >> 14)) as f64) / 4_294_967_296.0
    }
}

/// Seeded Fisher-Yates shuffle. Returns a new shuffled `Vec` (the input is not
/// mutated), matching the TS `shuffle` exactly including draw order.
pub fn shuffle<T: Clone>(items: &[T], rng: &mut Mulberry32) -> Vec<T> {
    let mut out = items.to_vec();
    let n = out.len();
    if n <= 1 {
        return out;
    }
    for i in (1..n).rev() {
        // j = Math.floor(rng() * (i + 1))
        let j = (rng.next_f64() * (i as f64 + 1.0)).floor() as usize;
        out.swap(i, j);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Determinism anchor: the same seed yields the same float sequence, and a
    // shuffle is reproducible. (Cross-checks against the TS mulberry32 values
    // are added by the engine worker if exact-value pinning is desired.)
    #[test]
    fn rng_is_deterministic() {
        let mut a = make_rng(42);
        let mut b = make_rng(42);
        for _ in 0..10 {
            assert_eq!(a.next_f64().to_bits(), b.next_f64().to_bits());
        }
    }

    #[test]
    fn shuffle_is_reproducible() {
        let xs: Vec<u32> = (0..20).collect();
        let mut r1 = make_rng(7);
        let mut r2 = make_rng(7);
        assert_eq!(shuffle(&xs, &mut r1), shuffle(&xs, &mut r2));
    }
}
