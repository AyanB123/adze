def get_user(db, user_id):
    if user_id is None:
        return None
    return db.fetch(user_id)


def check_permission(db, user_id, role):
    return db.role_of(user_id) == role
