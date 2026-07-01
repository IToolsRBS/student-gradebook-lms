select
    student_id::bigint as student_id,
    programme_id::bigint as programme_id,
    idnumber::text as student_idnumber,
    student_number::text as student_number,
    programme_name::text as programme_name,
    lower(email)::text as email,
    first_name::text as first_name,
    last_name::text as last_name,
    full_name::text as full_name,
    last_synced_at::timestamp as last_synced_at
from {{ source('raw', 'student') }}
