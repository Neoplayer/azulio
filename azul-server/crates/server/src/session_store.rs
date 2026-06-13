use std::collections::HashMap;
use std::sync::Mutex;

use azul_shared::PlayerId;

use crate::types::{Session, SessionStore};

type IdFactory = Box<dyn Fn() -> String + Send + Sync>;

/// In-memory `SessionStore`. Holds sessions by token, with a secondary index
/// from playerId → token.
pub struct InMemorySessionStore {
    inner: Mutex<Inner>,
    id_factory: IdFactory,
    token_factory: IdFactory,
}

struct Inner {
    by_token: HashMap<String, Session>,
    player_index: HashMap<PlayerId, String>,
}

impl InMemorySessionStore {
    /// Real store: random UUID ids and tokens (mirrors `new InMemorySessionStore()`).
    pub fn new() -> Self {
        Self::with_factories(
            Box::new(|| uuid::Uuid::new_v4().to_string()),
            Box::new(|| uuid::Uuid::new_v4().to_string()),
        )
    }

    /// Inject deterministic id/token factories (for tests).
    pub fn with_factories(id_factory: IdFactory, token_factory: IdFactory) -> Self {
        Self {
            inner: Mutex::new(Inner {
                by_token: HashMap::new(),
                player_index: HashMap::new(),
            }),
            id_factory,
            token_factory,
        }
    }
}

impl Default for InMemorySessionStore {
    fn default() -> Self {
        Self::new()
    }
}

impl SessionStore for InMemorySessionStore {
    fn create_session(&self, name: &str) -> (PlayerId, String) {
        let player_id = (self.id_factory)();
        let token = (self.token_factory)();
        let session = Session {
            player_id: player_id.clone(),
            token: token.clone(),
            name: name.to_string(),
            room_id: None,
        };
        let mut inner = self.inner.lock().unwrap();
        inner.by_token.insert(token.clone(), session);
        inner.player_index.insert(player_id.clone(), token.clone());
        (player_id, token)
    }

    fn get_by_token(&self, token: &str) -> Option<Session> {
        self.inner.lock().unwrap().by_token.get(token).cloned()
    }

    fn get_by_player_id(&self, player_id: &str) -> Option<Session> {
        let inner = self.inner.lock().unwrap();
        let token = inner.player_index.get(player_id)?;
        inner.by_token.get(token).cloned()
    }

    fn bind_room(&self, token: &str, room_id: &str) {
        let mut inner = self.inner.lock().unwrap();
        match inner.by_token.get_mut(token) {
            Some(session) => session.room_id = Some(room_id.to_string()),
            None => panic!("bind_room: unknown token \"{token}\""),
        }
    }

    fn unbind_room(&self, token: &str) {
        let mut inner = self.inner.lock().unwrap();
        match inner.by_token.get_mut(token) {
            Some(session) => session.room_id = None,
            None => panic!("unbind_room: unknown token \"{token}\""),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn counting_factory(prefix: &'static str) -> IdFactory {
        let n = Arc::new(AtomicU32::new(0));
        Box::new(move || format!("{prefix}{}", n.fetch_add(1, Ordering::SeqCst)))
    }

    #[test]
    fn create_and_lookup_by_token_and_player_id() {
        let store =
            InMemorySessionStore::with_factories(counting_factory("p"), counting_factory("t"));
        let (pid, token) = store.create_session("Alice");
        assert_eq!(pid, "p0");
        assert_eq!(token, "t0");

        let by_token = store.get_by_token(&token).unwrap();
        assert_eq!(by_token.name, "Alice");
        assert_eq!(by_token.player_id, "p0");

        let by_player = store.get_by_player_id(&pid).unwrap();
        assert_eq!(by_player.token, "t0");
    }

    #[test]
    fn unknown_token_returns_none() {
        let store = InMemorySessionStore::new();
        assert!(store.get_by_token("nope").is_none());
        assert!(store.get_by_player_id("nope").is_none());
    }

    #[test]
    fn bind_and_unbind_room() {
        let store = InMemorySessionStore::new();
        let (_pid, token) = store.create_session("Bob");
        store.bind_room(&token, "room-1");
        assert_eq!(
            store.get_by_token(&token).unwrap().room_id.as_deref(),
            Some("room-1")
        );
        store.unbind_room(&token);
        assert!(store.get_by_token(&token).unwrap().room_id.is_none());
    }

    #[test]
    #[should_panic(expected = "bind_room: unknown token")]
    fn bind_room_unknown_token_panics() {
        let store = InMemorySessionStore::new();
        store.bind_room("ghost", "room-1");
    }
}
