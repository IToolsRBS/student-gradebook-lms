select
    student_id,
    programme_id,
    student_number,
    full_name,
    email,
    last_portal_access_at,

    case
        when last_portal_access_at is null then null
        else extract(day from current_timestamp - last_portal_access_at)::integer
    end as days_since_last_portal_access,

    case
        when last_portal_access_at is null
            then 'No Portal Access Recorded'

        when current_timestamp - last_portal_access_at <= interval '7 days'
            then 'Active'

        when current_timestamp - last_portal_access_at <= interval '14 days'
            then 'Inactive 7-14 Days'

        when current_timestamp - last_portal_access_at <= interval '30 days'
            then 'Inactive 15-30 Days'

        else 'Inactive 30+ Days'
    end as portal_access_status

from {{ ref('stg_student') }}