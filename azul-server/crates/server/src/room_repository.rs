use std::collections::HashMap;
use std::sync::Mutex;

use azul_shared::Room;

use crate::types::{NewRoom, RoomPatch, RoomRepository};

type IdFactory = Box<dyn Fn() -> String + Send + Sync>;

/// In-memory `RoomRepository`. Ids default to random UUIDs; tests can inject a
/// deterministic id factory.
pub struct InMemoryRoomRepository {
    rooms: Mutex<HashMap<String, Room>>,
    id_factory: IdFactory,
}

impl InMemoryRoomRepository {
    pub fn new() -> Self {
        Self::with_id_factory(Box::new(|| uuid::Uuid::new_v4().to_string()))
    }

    pub fn with_id_factory(id_factory: IdFactory) -> Self {
        Self {
            rooms: Mutex::new(HashMap::new()),
            id_factory,
        }
    }
}

impl Default for InMemoryRoomRepository {
    fn default() -> Self {
        Self::new()
    }
}

impl RoomRepository for InMemoryRoomRepository {
    fn create(&self, room: NewRoom) -> Room {
        let id = (self.id_factory)();
        let full = Room {
            id: id.clone(),
            name: room.name,
            host_id: room.host_id,
            max_players: room.max_players,
            players: room.players,
            status: room.status,
            is_private: room.is_private,
            created_at: room.created_at,
        };
        self.rooms.lock().unwrap().insert(id, full.clone());
        full
    }

    fn get(&self, id: &str) -> Option<Room> {
        self.rooms.lock().unwrap().get(id).cloned()
    }

    fn list(&self) -> Vec<Room> {
        self.rooms.lock().unwrap().values().cloned().collect()
    }

    fn list_waiting(&self) -> Vec<Room> {
        self.rooms
            .lock()
            .unwrap()
            .values()
            .filter(|r| r.status == azul_shared::RoomStatus::Waiting)
            .cloned()
            .collect()
    }

    fn update(&self, id: &str, patch: RoomPatch) -> Room {
        let mut rooms = self.rooms.lock().unwrap();
        let existing = rooms
            .get_mut(id)
            .unwrap_or_else(|| panic!("RoomRepository.update: room \"{id}\" not found"));
        if let Some(name) = patch.name {
            existing.name = name;
        }
        if let Some(host_id) = patch.host_id {
            existing.host_id = host_id;
        }
        if let Some(max_players) = patch.max_players {
            existing.max_players = max_players;
        }
        if let Some(players) = patch.players {
            existing.players = players;
        }
        if let Some(status) = patch.status {
            existing.status = status;
        }
        if let Some(is_private) = patch.is_private {
            existing.is_private = is_private;
        }
        if let Some(created_at) = patch.created_at {
            existing.created_at = created_at;
        }
        // `id` is never patched.
        existing.clone()
    }

    fn delete(&self, id: &str) {
        self.rooms.lock().unwrap().remove(id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use azul_shared::{RoomPlayer, RoomStatus};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn counting_id_factory() -> IdFactory {
        let n = Arc::new(AtomicU32::new(0));
        Box::new(move || format!("room-{}", n.fetch_add(1, Ordering::SeqCst)))
    }

    fn sample_room(host: &str) -> NewRoom {
        NewRoom {
            name: "Test".into(),
            host_id: host.into(),
            max_players: 2,
            players: vec![RoomPlayer {
                id: host.into(),
                name: "Host".into(),
                bot: None,
            }],
            status: RoomStatus::Waiting,
            is_private: false,
            created_at: "2026-06-10T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn create_assigns_id_and_get_returns_it() {
        let repo = InMemoryRoomRepository::with_id_factory(counting_id_factory());
        let room = repo.create(sample_room("h1"));
        assert_eq!(room.id, "room-0");
        let fetched = repo.get("room-0").unwrap();
        assert_eq!(fetched.host_id, "h1");
    }

    #[test]
    fn list_waiting_filters_by_status() {
        let repo = InMemoryRoomRepository::with_id_factory(counting_id_factory());
        let r0 = repo.create(sample_room("h1"));
        let _r1 = repo.create(sample_room("h2"));
        repo.update(
            &r0.id,
            RoomPatch {
                status: Some(RoomStatus::Playing),
                ..Default::default()
            },
        );
        let waiting = repo.list_waiting();
        assert_eq!(waiting.len(), 1);
        assert_eq!(waiting[0].host_id, "h2");
    }

    #[test]
    fn update_patches_only_given_fields_and_preserves_id() {
        let repo = InMemoryRoomRepository::with_id_factory(counting_id_factory());
        let room = repo.create(sample_room("h1"));
        let updated = repo.update(
            &room.id,
            RoomPatch {
                status: Some(RoomStatus::Playing),
                ..Default::default()
            },
        );
        assert_eq!(updated.id, "room-0");
        assert_eq!(updated.status, RoomStatus::Playing);
        assert_eq!(updated.name, "Test"); // untouched
    }

    #[test]
    fn delete_removes_room() {
        let repo = InMemoryRoomRepository::with_id_factory(counting_id_factory());
        let room = repo.create(sample_room("h1"));
        repo.delete(&room.id);
        assert!(repo.get(&room.id).is_none());
    }

    #[test]
    #[should_panic(expected = "not found")]
    fn update_missing_room_panics() {
        let repo = InMemoryRoomRepository::new();
        repo.update("ghost", RoomPatch::default());
    }
}
